import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { createBillingReadRoutes } from "../../../../src/billing/presentation/routes.js";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";

type Event = { level: "info" | "warn" | "error"; name: string; data: Record<string, unknown> };

type FixtureOptions = {
  authFailure?: Error;
  billingFailure?: Error;
  catalogueFailure?: Error;
  billingValue?: unknown;
  catalogueValue?: unknown;
  withoutBilling?: boolean;
  withoutCatalogue?: boolean;
};

const principal = {
  installationId: "verified-installation",
  shopId: "verified-shop",
  canonicalSiteUrl: "https://verified-shop.example",
  credentialVersion: 5,
};

export const billingResponse = {
  schemaVersion: 1,
  experienceState: "ACTIVE",
  surfaces: {
    usageHistoryAllowed: true,
    purchaseHistoryAllowed: true,
    managePlansAllowed: true,
    cancelSubscriptionAllowed: false,
  },
  currentPlan: null,
  pendingPlan: null,
  pendingCancellation: null,
  capacity: {
    paidIncluded: null,
    freeLifetime: { granted: 5, committed: 1, reserved: 0, remaining: 4 },
    promotional: { granted: 0, committed: 0, reserved: 0, remaining: 0 },
    purchased: { granted: 0, committed: 0, reserved: 0, refunding: 0, available: 0 },
  },
  topUps: { configured: false, purchaseEligible: false, offers: [], latestPurchase: null, unresolvedPurchases: [] },
};

export const catalogueResponse = {
  schemaVersion: 1,
  resolvedLocale: "en",
  plans: [{
    merchantPricingPlanId: "free-plan",
    displayName: "Free",
    planKind: "FREE",
    cataloguePosition: 0,
    featured: false,
    localizedDescription: "Free plan",
    includedRecoveryCredits: 5,
    allowancePeriod: "LIFETIME",
    billingPeriod: "EVERY_30_DAYS",
    recurringAmountMinor: 0,
    currency: "USD",
    highlights: [],
  }],
};

export function fixture(options: FixtureOptions = {}) {
  const calls: string[] = [];
  const events: Event[] = [];
  const logger = {
    info(name: string, data: Record<string, unknown>) { events.push({ level: "info", name, data }); },
    warn(name: string, data: Record<string, unknown>) { events.push({ level: "warn", name, data }); },
    error(name: string, data: Record<string, unknown>) { events.push({ level: "error", name, data }); },
  };
  const authenticator = {
    async authenticate(request: IncomingMessage) {
      calls.push("authenticate");
      if (options.authFailure) throw options.authFailure;
      if (request.headers.authorization !== "Bearer verified-credential") throw new WooUnauthenticatedError();
      return principal;
    },
  };
  const billingReadService = {
    async read(who: typeof principal, at: Date) {
      calls.push(`billing:${who.shopId}:${at.toISOString()}`);
      if (options.billingFailure) throw options.billingFailure;
      return options.billingValue ?? billingResponse;
    },
  };
  const billingPlanCatalogueReadService = {
    async read(who: typeof principal, locale: string | undefined) {
      calls.push(`plans:${who.shopId}:${locale ?? "default"}`);
      if (options.catalogueFailure) throw options.catalogueFailure;
      return options.catalogueValue ?? catalogueResponse;
    },
  };
  const router = createBillingReadRoutes({
    authenticator: authenticator as never,
    ...(options.withoutBilling ? {} : { billingReadService: billingReadService as never }),
    ...(options.withoutCatalogue ? {} : { billingPlanCatalogueReadService: billingPlanCatalogueReadService as never }),
    logger: logger as never,
    now: () => Date.parse("2026-10-16T12:00:00.000Z"),
  });
  return { calls, events, router };
}

export async function withRouter(
  router: ReturnType<typeof createBillingReadRoutes>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void router.handle(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not_found"}');
      }
    }).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

export const authorizedHeaders = { authorization: "Bearer verified-credential", "x-shop-id": "spoofed-shop" };

export async function readRawGet(origin: string, path: string, body: string): Promise<{ status: number; data: unknown }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, {
      method: "GET",
      headers: { ...authorizedHeaders, "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(body);
  });
}
