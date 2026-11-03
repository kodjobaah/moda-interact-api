import { performance } from "node:perf_hooks";

/** Bounded per-request durations; never capture credentials, headers, customer data, or SQL parameters. */
export type FeaturePreferencesPhase =
  | "authenticationMs" | "authenticationLookupMs" | "authenticationOtherMs"
  | "requestValidationMs" | "requestBodyMs"
  | "serviceMs" | "transactionMs" | "transactionEntryMs" | "transactionWorkMs" | "transactionFinishMs"
  | "shopLookupMs" | "installationLookupMs" | "subscriptionLookupMs"
  | "shopValidationMs" | "installationValidationMs" | "subscriptionEligibilityMs"
  | "featuresLookupMs" | "preferencesLookupMs" | "capabilitySelectionMs"
  | "projectionMs" | "responseValidationMs" | "routeResponseValidationMs"
  | "featureUpsertsMs" | "responseDispatchMs";

export type FeaturePreferencesTimings = Partial<Record<FeaturePreferencesPhase, number>> & {
  failedPhase?: FeaturePreferencesPhase;
};

export function elapsedFeatureMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

/** Record elapsed time on success AND failure without altering the original thrown error. */
export async function timeFeaturePhase<T>(
  timings: FeaturePreferencesTimings | undefined,
  phase: FeaturePreferencesPhase,
  operation: () => Promise<T>,
): Promise<T> {
  if (!timings) return operation();
  const startedAt = performance.now();
  try { return await operation(); }
  catch (error) {
    timings.failedPhase ??= phase;
    throw error;
  } finally {
    timings[phase] = elapsedFeatureMs(startedAt);
  }
}

export function timeFeatureSync<T>(
  timings: FeaturePreferencesTimings | undefined,
  phase: FeaturePreferencesPhase,
  operation: () => T,
): T {
  if (!timings) return operation();
  const startedAt = performance.now();
  try { return operation(); }
  catch (error) {
    timings.failedPhase ??= phase;
    throw error;
  } finally {
    timings[phase] = elapsedFeatureMs(startedAt);
  }
}
