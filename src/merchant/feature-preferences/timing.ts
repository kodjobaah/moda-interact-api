export type FeaturePreferenceLoadPhase = "initial" | "final";
export type FeaturePreferenceLoadTimings = Record<string, number>;
export type FeaturePreferenceTimingSink = (timings: Readonly<FeaturePreferenceLoadTimings>) => void;

export async function measureFeaturePreferencePhase<T>(
  timings: FeaturePreferenceLoadTimings,
  phase: FeaturePreferenceLoadPhase,
  name: "subscriptionLookupMs" | "featuresLookupMs" | "preferencesLookupMs" | "projectionMs",
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    timings[`${phase}.${name}`] = Math.max(0, performance.now() - started);
  }
}

export function measureFeaturePreferenceProjection<T>(
  timings: FeaturePreferenceLoadTimings,
  phase: FeaturePreferenceLoadPhase,
  project: () => T,
): T {
  const started = performance.now();
  try {
    return project();
  } finally {
    timings[`${phase}.projectionMs`] = Math.max(0, performance.now() - started);
  }
}