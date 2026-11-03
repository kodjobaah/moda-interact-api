import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveModaConfigurationLocale } from "@modainteract/moda-interact-shared/internationalization";
import type { WooInstallationPrincipal } from "../../auth/woo-installation/principal.js";
import { MerchantKnowledgeReadError } from "./contract.js";
import { readEntitlement, readWriterEntitlement, type MerchantKnowledgeReadService } from "./read.service.js";
import { KnowledgeCommandError, KnowledgeCommandPostCommitError, type CreateWebSource, type PatchWebSource,
  type SourceGeneration, type SourceOrder } from "./commands.contract.js";

type Tx = Prisma.TransactionClient;
type Configuration = NonNullable<Awaited<ReturnType<typeof readEntitlement>>["configuration"]>;
const denied = (): never => { throw new KnowledgeCommandError(403, "merchant_knowledge_denied"); };
function conflict(cause?: unknown): never {
  throw new KnowledgeCommandError(409, "merchant_knowledge_conflict", cause === undefined ? undefined : { cause });
}
const notFound = (): never => { throw new KnowledgeCommandError(404, "merchant_knowledge_source_not_found"); };

async function lockedEntitlement(tx: Tx, principal: WooInstallationPrincipal): Promise<{ config: Configuration; language: string }> {
  // All writer routes share the same row lock, including edits to existing source order.
  const shops = await tx.$queryRaw<Array<{ id: string; domain: string; platform: string; shopifyShopId: string | null;
    status: string; defaultLanguageTag: string | null }>>(Prisma.sql`
    SELECT "id", "domain", "platform", "shopifyShopId", "status", "defaultLanguageTag"
    FROM "commerce"."Shop" WHERE "id" = ${principal.shopId} FOR UPDATE
  `);
  const shop = shops[0];
  if (!shop) throw new KnowledgeCommandError(409, "merchant_knowledge_integrity_invalid");
  // A revocation/rotation must not race with an in-flight authenticated write.
  const installations = await tx.$queryRaw<Array<{ id: string; shopId: string; canonicalSiteUrl: string;
    credentialVersion: number; status: string; revokedAt: Date | null }>>(Prisma.sql`
    SELECT "id", "shopId", "canonicalSiteUrl", "credentialVersion", "status", "revokedAt"
    FROM "woocommerce"."WooCommerceInstallation"
    WHERE "id" = ${principal.installationId} FOR SHARE
  `);
  const installation = installations[0];
  if (shop.id !== principal.shopId || shop.domain !== principal.canonicalSiteUrl || shop.platform !== "WOOCOMMERCE" ||
    shop.shopifyShopId !== null || shop.status !== "ACTIVE" || !installation ||
    installation.id !== principal.installationId || installation.shopId !== principal.shopId ||
    installation.canonicalSiteUrl !== principal.canonicalSiteUrl || installation.credentialVersion !== principal.credentialVersion ||
    installation.status !== "ACTIVE" || installation.revokedAt !== null) {
    throw new KnowledgeCommandError(409, "merchant_knowledge_integrity_invalid");
  }
  let config: Configuration | null;
  try { config = await readWriterEntitlement(tx, principal.shopId); }
  catch (error) {
    if (error instanceof MerchantKnowledgeReadError) {
      if (error.status === 503) throw new KnowledgeCommandError(503, "merchant_knowledge_unavailable", { cause: error });
      throw new KnowledgeCommandError(409, "merchant_knowledge_integrity_invalid", { cause: error });
    }
    throw error;
  }
  if (!config) return denied();
  return { config, language: resolveModaConfigurationLocale(shop.defaultLanguageTag) };
}

const selectCreateSource = {
  id: true, name: true, languageTag: true, position: true,
  purpose: { select: { key: true, active: true } },
  dataFormat: { select: { key: true, active: true, inputKind: true } },
  revisions: { orderBy: { generation: "desc" as const }, take: 1,
    select: { requestedUrl: true, status: true } },
} as const;
const selectEligibleSource = {
  id: true, position: true,
  purpose: { select: { key: true, active: true } },
  dataFormat: { select: { key: true, active: true, inputKind: true } },
} as const;
type SourceEligibilityRow = { id: string; position: number; purpose: { key: string; active: boolean };
  dataFormat: { key: string; active: boolean; inputKind: string } };
async function createSources(tx: Tx, shopId: string) {
  return tx.merchantKnowledgeSource.findMany({ where: { shopId }, orderBy: [{ position: "asc" }, { id: "asc" }],
    select: selectCreateSource });
}
async function eligibleSources(tx: Tx, shopId: string) {
  return tx.merchantKnowledgeSource.findMany({ where: { shopId }, orderBy: [{ position: "asc" }, { id: "asc" }],
    select: selectEligibleSource });
}
async function orderedSources(tx: Tx, shopId: string) {
  return tx.merchantKnowledgeSource.findMany({ where: { shopId }, orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true, position: true } });
}
async function webSource(tx: Tx, shopId: string, id: string) {
  const source = await tx.merchantKnowledgeSource.findFirst({ where: { id, shopId }, select: {
    id: true, name: true, languageTag: true, position: true, currentGeneration: true,
    purpose: { select: { key: true, active: true } },
    dataFormat: { select: { key: true, active: true, inputKind: true } },
    revisions: { orderBy: { generation: "desc" }, take: 1, select: { requestedUrl: true, status: true } },
  } });
  if (!source || source.dataFormat.key !== "WEB_PAGE" || source.dataFormat.inputKind !== "REMOTE_URL") return notFound();
  return source;
}
function eligible(config: Configuration, rows: readonly SourceEligibilityRow[]) {
  return rows.filter((source) => source.purpose.active && source.dataFormat.active &&
    config.allowedSourceTypes.some((pair) => pair.purposeKey === source.purpose.key && pair.dataFormatKey === source.dataFormat.key));
}
function assertEligible(config: Configuration, rows: readonly SourceEligibilityRow[], source: SourceEligibilityRow) {
  if (!eligible(config, rows).slice(0, config.maxKnowledgeSources).some(({ id }) => id === source.id)) denied();
}
function checkGeneration(row: { currentGeneration: number }, generation: number) {
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
/** Stage only changed rows above the current maximum, preserving unique positions and untouched timestamps. */
async function compact(tx: Tx, shopId: string, orderedIds: string[], rows: readonly { id: string; position: number }[]) {
  const currentIds = new Set(rows.map(({ id }) => id));
  if (rows.length !== orderedIds.length || new Set(orderedIds).size !== orderedIds.length ||
    orderedIds.some((id) => !currentIds.has(id)) || rows.some(({ position }) =>
      !Number.isSafeInteger(position) || position < 0 || position >= 1_000_000_000)) conflict();
  const positions = new Map(orderedIds.map((id, index) => [id, index]));
  const changedRows = rows.filter(({ id, position }) => positions.get(id) !== position);
  if (changedRows.length === 0) return;
  const highest = Math.max(...rows.map(({ position }) => position));
  if (highest + changedRows.length > 2147483647) conflict();
  for (const [index, row] of changedRows.entries()) {
    const staged = await tx.merchantKnowledgeSource.updateMany({ where: { id: row.id, shopId },
      data: { position: highest + index + 1 } });
    if (staged.count !== 1) conflict();
  }
  for (const row of changedRows) {
    const changed = await tx.merchantKnowledgeSource.updateMany({ where: { id: row.id, shopId },
      data: { position: positions.get(row.id)! } });
    if (changed.count !== 1) conflict();
  }
}

export class MerchantKnowledgeCommandService {
  constructor(private readonly db: Pick<PrismaClient, "$transaction">,
    private readonly readService: MerchantKnowledgeReadService) {}

  private async transact<T>(handler: (tx: Tx) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(handler, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 12000 }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) conflict(error);
      throw error;
    }
  }
  private async response(principal: WooInstallationPrincipal, sourceId?: string, created?: boolean) {
    try {
      return { ...(sourceId ? { sourceId } : {}), ...(created !== undefined ? { created } : {}),
        knowledge: await this.readService.read(principal) };
    } catch (error) { throw new KnowledgeCommandPostCommitError(error); }
  }
  async create(principal: WooInstallationPrincipal, input: CreateWebSource) {
    const output = await this.transact(async (tx) => {
      const { config, language } = await lockedEntitlement(tx, principal);
      const pair = await permittedPair(tx, config, input.purposeKey);
      const languageTag = input.languageTag ?? language;
      const rows = await createSources(tx, principal.shopId);
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
      const rows = await eligibleSources(tx, principal.shopId);
      const row = await webSource(tx, principal.shopId, id);
      checkGeneration(row, input.expectedGeneration);
      assertEligible(config, rows, row);
      const previous = row.revisions[0]?.requestedUrl;
      if (!previous) conflict();
      const name = input.name ?? row.name;
      const languageTag = input.languageTag ?? row.languageTag;
      const url = input.url ?? previous;
      const urlChanged = url !== previous;
      if (name === row.name && languageTag === row.languageTag && !urlChanged) return;
      const changed = await tx.merchantKnowledgeSource.updateMany({ where: {
        id: row.id, shopId: principal.shopId, currentGeneration: input.expectedGeneration,
      }, data: {
        name, languageTag, ...(urlChanged ? { currentGeneration: { increment: 1 } } : {}),
      } });
      if (changed.count !== 1) conflict();
      if (urlChanged) await newRevision(tx, id, row.currentGeneration + 1, "URL_CHANGE", url);
    });
    return this.response(principal);
  }
  async refresh(principal: WooInstallationPrincipal, id: string, input: SourceGeneration) {
    await this.transact(async (tx) => {
      const { config } = await lockedEntitlement(tx, principal);
      const rows = await eligibleSources(tx, principal.shopId);
      const row = await webSource(tx, principal.shopId, id);
      checkGeneration(row, input.expectedGeneration);
      assertEligible(config, rows, row);
      const latest = row.revisions[0];
      if (!latest?.requestedUrl) conflict();
      // Replaying a refresh while it is queued/processing cannot make duplicate generations.
      if (latest.status === "PENDING" || latest.status === "PROCESSING") return;
      const changed = await tx.merchantKnowledgeSource.updateMany({ where: {
        id, shopId: principal.shopId, currentGeneration: input.expectedGeneration,
      }, data: { currentGeneration: { increment: 1 } } });
      if (changed.count !== 1) conflict();
      await newRevision(tx, id, row.currentGeneration + 1, "REFRESH", latest.requestedUrl);
    });
    return this.response(principal);
  }
  async remove(principal: WooInstallationPrincipal, id: string, input: SourceGeneration) {
    await this.transact(async (tx) => {
      const { config } = await lockedEntitlement(tx, principal);
      const rows = await eligibleSources(tx, principal.shopId);
      const row = await webSource(tx, principal.shopId, id);
      checkGeneration(row, input.expectedGeneration);
      assertEligible(config, rows, row);
      const deleted = await tx.merchantKnowledgeSource.deleteMany({ where: {
        id, shopId: principal.shopId, currentGeneration: input.expectedGeneration,
      } });
      if (deleted.count !== 1) conflict();
      const remaining = rows.filter((source) => source.id !== id);
      await compact(tx, principal.shopId, remaining.map(({ id: sourceId }) => sourceId), remaining);
    });
    return this.response(principal);
  }
  async order(principal: WooInstallationPrincipal, input: SourceOrder) {
    await this.transact(async (tx) => {
      await lockedEntitlement(tx, principal); // any entitled merchant may order dormant as well as active sources
      const rows = await orderedSources(tx, principal.shopId);
      if (rows.length !== input.sourceIds.length || new Set(input.sourceIds).size !== input.sourceIds.length ||
        rows.some((row) => !input.sourceIds.includes(row.id))) conflict();
      if (rows.every((row, index) => row.id === input.sourceIds[index] && row.position === index)) return;
      await compact(tx, principal.shopId, input.sourceIds, rows);
    });
    return this.response(principal);
  }
}
