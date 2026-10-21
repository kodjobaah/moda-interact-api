export interface WooBillingTarget {
  environment: "sandbox" | "production";
  baseUrl: "https://sandbox.woocommerce.com/wp-json/wccom/billing/1.0/" | "https://woocommerce.com/wp-json/wccom/billing/1.0/";
}

export interface WooBillingConfig extends WooBillingTarget {
  apiKey: string;
  apiSecret: string;
}

/** Provider endpoint selection is deployment-owned; both credentials are database-owned. */
export function loadWooBillingConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WooBillingTarget | null {
  const selectedEnvironment = environment.WOO_BILLING_ENVIRONMENT?.trim();
  if (!selectedEnvironment) return null;
  if (selectedEnvironment !== "sandbox" && selectedEnvironment !== "production") {
    throw new Error("WOO_BILLING_ENVIRONMENT must be sandbox or production");
  }
  return Object.freeze({
    environment: selectedEnvironment,
    baseUrl: selectedEnvironment === "sandbox"
      ? "https://sandbox.woocommerce.com/wp-json/wccom/billing/1.0/"
      : "https://woocommerce.com/wp-json/wccom/billing/1.0/",
  });
}
