/** Authoritative tenant identity resolved from the active WooCommerce installation row. */
export interface WooInstallationPrincipal {
  installationId: string;
  shopId: string;
  canonicalSiteUrl: string;
  credentialVersion: number;
}
