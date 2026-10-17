import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveModaConfigurationLocale } from "@modainteract/moda-interact-shared/internationalization";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { MerchantKnowledgeReadError } from "./contract.js";
import { assertWooPrincipal, readEntitlement, type MerchantKnowledgeReadService } from "./read.service.js";
import { KnowledgeCommandError, type CreateWebSource, type PatchWebSource, type SourceGeneration, type SourceOrder } from "./commands.contract.js";

type Tx = Prisma.TransactionClient;
type Configuration = NonNullable<Awaited<ReturnType<typeof readEntitlement>>["configuration"]>;
const denied = (): never => { throw new KnowledgeCommandError(403, "merchant_knowledge_denied"); };
function conflict(): never { throw new KnowledgeCommandError(409, "merchant_knowledge_conflict"); }
const notFound = (): never => { throw new KnowledgeCommandError(404, "merchant_knowledge_source_not_found"); };

async function lockedEntitlement(tx: Tx, principal: WooInstallationPrincipal): Promise<{ config: Configuration; language: string }> {
  // All writer routes share the same row lock, including edits to existing source order.
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
  `);
  if (!rows.length) throw new KnowledgeCommandError(409, "merchant_knowledge_integrity_invalid");
  // A revocation/rotation must not race with an in-flight authenticated write.
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "woocommerce"."WooCommerceInstallation"
    WHERE "id" = ${principal.installationId} FOR SHARE
  `);
  let defaultLanguage: string | null;
  try { defaultLanguage = await assertWooPrincipal(tx, principal); }
  catch (error) {
    if (error instanceof MerchantKnowledgeReadError) {
      throw new KnowledgeCommandError(409, "merchant_knowledge_integrity_invalid");
    }
    throw error;
  }
  const { configuration } = await readEntitlement(tx, principal.shopId);
  if (!configuration) return denied();
  return { config: configuration, language: resolveModaConfigurationLocale(defaultLanguage) };
}

const selectSource = {
  id: true, shopId: true, name: true, languageTag: true, position: true, currentGeneration: true,
  purpose: { select: { key: true, active: true } },
  dataFormat: { select: { key: true, active: true, inputKind: true } },
  revisions: { orderBy: { generation: "desc" as const }, take: 1,
    select: { requestedUrl: true, status: true } },
} as const;
async function sources(tx: Tx, shopId: string) {
  return tx.merchantKnowledgeSource.findMany({ where: { shopId }, orderBy: [{ position: "asc" }, { id: "asc" }], select: selectSource });
}
type SourceRow = Awaited<ReturnType<typeof sources>>[number];
function eligible(config: Configuration, rows: SourceRow[]) {
  return rows.filter((source) => source.purpose.active && source.dataFormat.active &&
    config.allowedSourceTypes.some((pair) => pair.purposeKey === source.purpose.key && pair.dataFormatKey === source.dataFormat.key));
}
function assertEligible(config: Configuration, rows: SourceRow[], source: SourceRow) {
  if (!eligible(config, rows).slice(0, config.maxKnowledgeSources).some(({ id }) => id === source.id)) denied();
}
function webSource(rows: SourceRow[], id: string): SourceRow {
  const source = rows.find((row) => row.id === id);
  if (!source || source.dataFormat.key !== "WEB_PAGE" || source.dataFormat.inputKind !== "REMOTE_URL") return notFound();
  return source;
}
function checkGeneration(row: SourceRow, generation: number) {
  if (row.currentGeneration !== generation) conflict();
}
async function newRevision(tx: Tx, sourceId: string, generation: number, reason: "CREATE" | "URL_CHANGE" | "REFRESH", url: string) {
  await tx.merchantKnowledgeSourceRevision.create({ data: {
    id: randomUUID(), sourceId, generation, reason, requestedUrl: url, status: "PENDING", requestedAt: new Date(),
  } });
  // Background reconciliation discovers durable PENDING revisions. Never enqueue inside this transaction.
}
async function permittedPair(tx: Tx, config: Configuration, purposeKey: string) {
  if (!config.allowedSourceTypes.some((pair) => pair.purposeKey === purposeKey && pair.dataFormatKey === "WEB_PAGE")) return denied();
  const pair = await tx.merchantKnowledgePurposeDataFormat.findFirst({ where: {
    purpose: { key: purposeKey, active: true }, dataFormat: { key: "WEB_PAGE", active: true, inputKind: "REMOTE_URL" },
  }, select: { purposeId: true, dataFormatId: true } });
  if (!pair) denied();
  return pair!;
}
/** Positions are unique and constrained nonnegative: move every row into a separate, positive staging range first. */
async function compact(tx: Tx, shopId: string, orderedIds: string[], rows: SourceRow[]) {
  if (rows.length !== orderedIds.length || rows.some(({ id }) => !orderedIds.includes(id)) || rows.some(({ position }) => position >= 1_000_000_000)) conflict();
  for (const [index, row] of rows.entries()) {
    await tx.merchantKnowledgeSource.update({ where: { id: row.id }, data: { position: 1_000_000_000 + index } });
  }
  for (const [index, id] of orderedIds.entries()) {
    const changed = await tx.merchantKnowledgeSource.updateMany({ where: { id, shopId }, data: { position: index } });
    if (changed.count !== 1) conflict();
  }
}

export class MerchantKnowledgeCommandService {
  constructor(private readonly db: Pick<PrismaClient, "$transaction">,
    private readonly readService: MerchantKnowledgeReadService) {}

  private async transact<T>(handler: (tx: Tx) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(handler, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 12000 }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) conflict();
      throw error;
    }
  }
  private async response(principal: WooInstallationPrincipal, sourceId?: string, created?: boolean) {
    return { ...(sourceId ? { sourceId } : {}), ...(created !== undefined ? { created } : {}),
      knowledge: await this.readService.read(principal) };
  }
  async create(principal: WooInstallationPrincipal, input: CreateWebSource) {
    const output = await this.transact(async (tx) => {
      const { config, language } = await lockedEntitlement(tx, principal);
      const pair = await permittedPair(tx, config, input.purposeKey);
      const languageTag = input.languageTag ?? language;
      const rows = await sources(tx, principal.shopId);
      const duplicate = rows.find((row) => row.name === input.name && row.languageTag === languageTag &&
        row.purpose.key === input.purposeKey && row.dataFormat.key === "WEB_PAGE" && row.revisions[0]?.requestedUrl === input.url);
      if (duplicate) return { sourceId: duplicate.id, created: false };
      if (eligible(config, rows).length >= config.maxKnowledgeSources || rows.length >= 1000) denied();
      const position = rows.length ? Math.max(...rows.map(({ position }) => position)) + 1 : 0;
      if (position >= 1_000_000_000) conflict();
      const sourceId = randomUUID();
      await tx.merchantKnowledgeSource.create({ data: { id: sourceId, shopId: principal.shopId,
        purposeId: pair.purposeId, dataFormatId: pair.dataFormatId, name: input.name, languageTag, position, currentGeneration: 1 } });
      await newRevision(tx, sourceId, 1, "CREATE", input.url);
      return { sourceId, created: true };
    });
    return this.response(principal, output.sourceId, output.created);
  }
  async patch(principal: WooInstallationPrincipal, id: string, input: PatchWebSource) {
    await this.transact(async (tx) => {
      const { config } = await lockedEntitlement(tx, principal);
      const rows = await sources(tx, principal.shopId);
      const row = webSource(rows, id);
      checkGeneration(row, input.expectedGeneration);
      assertEligible(config, rows, row);
      const previous = row.revisions[0]?.requestedUrl;
      if (!previous) conflict();
      const name = input.name ?? row.name;
      const languageTag = input.languageTag ?? row.languageTag;
      const url = input.url ?? previous;
      const urlChanged = url !== previous;
      if (name === row.name && languageTag === row.languageTag && !urlChanged) return;
      await tx.merchantKnowledgeSource.update({ where: { id: row.id }, data: {
        name, languageTag, ...(urlChanged ? { currentGeneration: { increment: 1 } } : {}),
      } });
      if (urlChanged) await newRevision(tx, id, row.currentGeneration + 1, "URL_CHANGE", url);
    });
    return this.response(principal);
  }
  async refresh(principal: WooInstallationPrincipal, id: string, input: SourceGeneration) {
    await this.transact(async (tx) => {
      const { config } = await lockedEntitlement(tx, principal);
      const rows = await sources(tx, principal.shopId);
      const row = webSource(rows, id);
      checkGeneration(row, input.expectedGeneration);
      assertEligible(config, rows, row);
      const latest = row.revisions[0];
      if (!latest?.requestedUrl) conflict();
      // Replaying a refresh while it is queued/processing cannot make duplicate generations.
      if (latest.status === "PENDING" || latest.status === "PROCESSING") return;
      await tx.merchantKnowledgeSource.update({ where: { id }, data: { currentGeneration: { increment: 1 } } });
      await newRevision(tx, id, row.currentGeneration + 1, "REFRESH", latest.requestedUrl);
    });
    return this.response(principal);
  }
  async remove(principal: WooInstallationPrincipal, id: string, input: SourceGeneration) {
    await this.transact(async (tx) => {
      const { config } = await lockedEntitlement(tx, principal);
      const rows = await sources(tx, principal.shopId);
      const row = webSource(rows, id);
      checkGeneration(row, input.expectedGeneration);
      assertEligible(config, rows, row);
      await tx.merchantKnowledgeSource.delete({ where: { id } });
      await compact(tx, principal.shopId, rows.filter((source) => source.id !== id).map(({ id: sourceId }) => sourceId),
        rows.filter((source) => source.id !== id));
    });
    return this.response(principal);
  }
  async order(principal: WooInstallationPrincipal, input: SourceOrder) {
    await this.transact(async (tx) => {
      await lockedEntitlement(tx, principal); // any entitled merchant may order dormant as well as active sources
      const rows = await sources(tx, principal.shopId);
      if (rows.length !== input.sourceIds.length || rows.some((row) => !input.sourceIds.includes(row.id))) conflict();
      if (rows.every((row, index) => row.id === input.sourceIds[index] && row.position === index)) return;
      await compact(tx, principal.shopId, input.sourceIds, rows);
    });
    return this.response(principal);
  }
}
