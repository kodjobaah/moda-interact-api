export interface WooBillingConfig {
  environment: "sandbox" | "production";
  apiKey: string;
  apiSecret: string;
  baseUrl: "https://sandbox.woocommerce.com/wp-json/wccom/billing/1.0/" | "https://woocommerce.com/wp-json/wccom/billing/1.0/";
}

export function loadWooBillingConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WooBillingConfig | null {
  const selectedEnvironment = environment.WOO_BILLING_ENVIRONMENT?.trim();
  const apiKey = environment.WOO_BILLING_API_KEY?.trim();
  const apiSecret = environment.WOO_BILLING_API_SECRET?.trim();
  const supplied = [selectedEnvironment, apiKey, apiSecret].some(Boolean);
  if (!supplied) return null;
  if (selectedEnvironment !== "sandbox" && selectedEnvironment !== "production") {
    throw new Error("WOO_BILLING_ENVIRONMENT must be sandbox or production");
  }
  if (!apiKey || !apiSecret) throw new Error("WOO_BILLING_API_KEY and WOO_BILLING_API_SECRET are required together");
  return {
    environment: selectedEnvironment,
    apiKey,
    apiSecret,
    baseUrl: selectedEnvironment === "sandbox"
      ? "https://sandbox.woocommerce.com/wp-json/wccom/billing/1.0/"
      : "https://woocommerce.com/wp-json/wccom/billing/1.0/",
  };
}