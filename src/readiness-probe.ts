/** Share pending work until the delegate itself settles. HTTP observers have their own deadlines. */
export function createSingleFlightReadinessProbe(delegate: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return () => {
    inFlight ??= Promise.resolve().then(delegate).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
