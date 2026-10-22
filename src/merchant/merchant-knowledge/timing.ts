import { performance } from "node:perf_hooks";

/** Per-request, bounded timing fields for the Woo Merchant Knowledge API; no request data is collected. */
export type KnowledgeTimingPhase =
  | "authenticationMs" | "requestBodyMs" | "configurationMs" | "intentTransactionMs" | "signingMs"
  | "preliminaryTransactionMs" | "r2VerificationMs" | "r2HeadMs" | "r2GetMs" | "r2HashMs"
  | "commitTransactionMs" | "shopValidationMs" | "entitlementAndCountMs" | "sourceQueriesMs" | "activeRevisionsMs";

export type KnowledgeTimings = Partial<Record<KnowledgeTimingPhase, number>>;

export function elapsedMs(start: number): number {
  return Math.max(0, Math.round((performance.now() - start) * 100) / 100);
}

/** Records a completed phase even when its operation rejects; does not change failure semantics. */
export async function timeKnowledgePhase<T>(
  timings: KnowledgeTimings | undefined, phase: KnowledgeTimingPhase, operation: () => Promise<T>,
): Promise<T> {
  if (!timings) return operation();
  const startedAt = performance.now();
  try { return await operation(); }
  finally { timings[phase] = elapsedMs(startedAt); }
}
