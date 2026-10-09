import { createHash } from "node:crypto";
import {
  CommerceAgentPromptScope,
  CommercePromptRevisionStatus,
  type CommerceEnvironment,
  type Prisma,
} from "@prisma/client";
import { categoryConflict } from "./selection-errors.js";
import type { PreparedCategorySelection } from "./selection-preparation.js";

/** Publish the canonical SHOP prompt and switch only the selected environment. */
export async function publishCategorySelection(
  tx: Prisma.TransactionClient,
  shopId: string,
  environment: CommerceEnvironment,
  prepared: PreparedCategorySelection,
  pendingRevisionId: string | null,
  now: Date,
): Promise<string> {
  const lineages = await tx.commerceAgentPrompt.findMany({
    where: { scope: CommerceAgentPromptScope.SHOP, shopId },
    take: 2,
    select: { id: true },
  });
  if (lineages.length > 1) throw categoryConflict();
  if (!lineages[0] && pendingRevisionId) throw categoryConflict();
  const lineage = lineages[0] ?? await tx.commerceAgentPrompt.create({
    data: { scope: CommerceAgentPromptScope.SHOP, shopId },
    select: { id: true },
  });

  const configurations = await tx.commerceAgentConfiguration.findMany({
    where: { environment, scope: CommerceAgentPromptScope.SHOP, shopId },
    take: 2,
    select: {
      id: true,
      activePromptRevision: { select: { promptId: true } },
    },
  });
  if (configurations.length > 1 ||
    (configurations[0]?.activePromptRevision && configurations[0].activePromptRevision.promptId !== lineage.id)) {
    throw categoryConflict();
  }

  const contentHash = createHash("sha256").update(prepared.promptText, "utf8").digest("hex");
  let revisionId: string;
  if (pendingRevisionId) {
    const draft = await tx.commerceAgentPromptRevision.findUnique({
      where: { id: pendingRevisionId },
      select: { id: true, promptId: true, status: true },
    });
    if (!draft || draft.promptId !== lineage.id || draft.status !== CommercePromptRevisionStatus.DRAFT) throw categoryConflict();
    const published = await tx.commerceAgentPromptRevision.updateMany({
      where: { id: draft.id, promptId: lineage.id, status: CommercePromptRevisionStatus.DRAFT },
      data: {
        status: CommercePromptRevisionStatus.PUBLISHED,
        promptText: prepared.promptText,
        sourceTemplateId: prepared.templateId,
        sourceTemplateEditVersion: prepared.templateEditVersion,
        sourceContext: prepared.sourceContext,
        contentHash,
        publishedAt: now,
        editVersion: { increment: 1 },
      },
    });
    if (published.count !== 1) throw categoryConflict();
    revisionId = draft.id;
  } else {
    const existingDraft = await tx.commerceAgentPromptRevision.findFirst({
      where: { promptId: lineage.id, status: CommercePromptRevisionStatus.DRAFT },
      select: { id: true },
    });
    if (existingDraft) throw categoryConflict();
    const latestRevision = await tx.commerceAgentPromptRevision.findFirst({
      where: { promptId: lineage.id },
      orderBy: { revisionNumber: "desc" },
      select: { revisionNumber: true },
    });
    const nextRevision = (latestRevision?.revisionNumber ?? 0) + 1;
    if (!Number.isSafeInteger(nextRevision)) throw categoryConflict();
    const published = await tx.commerceAgentPromptRevision.create({
      data: {
        promptId: lineage.id,
        revisionNumber: nextRevision,
        status: CommercePromptRevisionStatus.PUBLISHED,
        promptText: prepared.promptText,
        sourceTemplateId: prepared.templateId,
        sourceTemplateEditVersion: prepared.templateEditVersion,
        sourceContext: prepared.sourceContext,
        contentHash,
        publishedAt: now,
      },
      select: { id: true },
    });
    revisionId = published.id;
  }

  if (configurations[0]) {
    await tx.commerceAgentConfiguration.update({
      where: { id: configurations[0].id },
      data: { activePromptRevisionId: revisionId, promptEditVersion: { increment: 1 } },
    });
  } else {
    await tx.commerceAgentConfiguration.create({
      data: {
        environment, scope: CommerceAgentPromptScope.SHOP, shopId,
        activePromptRevisionId: revisionId, promptEditVersion: 2,
      },
    });
  }
  return revisionId;
}
