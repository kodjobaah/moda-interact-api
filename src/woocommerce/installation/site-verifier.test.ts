import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import test from "node:test";
import { createSiteProof, randomSecret } from "./credential.js";
import { canonicalizeWooSiteUrl } from "./site-url.js";
import {
  isApprovedPeerAddress,
  isLocalAddress,
  isPublicAddress,
  SiteVerificationError,
  WooSiteVerifier,
} from "./site-verifier.js";

const attemptId = "550e8400-e29b-41d4-a716-446655440000";
const secret = Buffer.alloc(32, 9);
const nonce = Buffer.alloc(32, 5);
const testCertificate = `-----BEGIN CERTIFICATE-----
MIIDTzCCAjegAwIBAgIUbD7yMTYL4uyUxVP/aSsxiQ+Md4IwDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZd29vY29tbWVyY2Utc2FuZGJveC5sb2NhbDAeFw0yNjEw
MDMxMzUxNDNaFw0zNjA5MzAxMzUxNDNaMCQxIjAgBgNVBAMMGXdvb2NvbW1lcmNl
LXNhbmRib3gubG9jYWwwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDN
8bvBkDOOqZLyANUL/LR/VlyuYpF4XX7HoELoIF2641M0xObPpawGPc5tZgrM4ocp
B1ZaPPT8+UIPCderwy97M0cexV9Mhe0JiaM1hgHnWEkTe8GUYQ4tQIpxXCnigVKu
uZIFrAdsA0fQa6tE+dsT7UmjHKsdnY4G58a53Y5dimXB4NAhGmHgbg5T3IRf3qfp
/Lq+rov4yTaTXhBvsNvIRyEBWkGsWjpsOrs0mAWCDtvGPVFsfWZc9qPxYWU3aLQ0
3bl3FXoC4u0b97Cxxeunyi7nfkVzGzFb2GAMk/aNlq9/5daqAqwuJEJ7iEo/ovYr
HmPfgjXLx4GpT9JCWIEjAgMBAAGjeTB3MB0GA1UdDgQWBBTRht4+Z/TohW+8KgS4
9oURV3hF2DAfBgNVHSMEGDAWgBTRht4+Z/TohW+8KgS49oURV3hF2DAPBgNVHRMB
Af8EBTADAQH/MCQGA1UdEQQdMBuCGXdvb2NvbW1lcmNlLXNhbmRib3gubG9jYWww
DQYJKoZIhvcNAQELBQADggEBAIIZYEGLgS4W1m6Hytb880Jhc8M1A10/U359lXmF
X5i+DV32D+1aqfka86WYfmU2jOosXWhJexfK3ej/sIIE1M6ddhY3iXHpdu6NHSkk
gtHCNO+z0AWeEDLrHBk4vieysNKICBe2bjqW52lUFoD0nzACR4d55PMNXfdcLzOR
hu2X/psgkHrTXicvh1FM39753LCqdKhTFxaiHDjUwQBjMI2im4Cm/i/Kn3e6f91D
/f3s+e7kJ/6OlKn2tQE4wjGAv4uS2YHqkkjq2RTm8QuZRJhJ+9+ETK+UqyXIpiQV
MXWUStGtSGBbFM4+ps1FIhKgoFLTGPCot3fsrHDVamyFPTg=
-----END CERTIFICATE-----`;
const testPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDN8bvBkDOOqZLy
ANUL/LR/VlyuYpF4XX7HoELoIF2641M0xObPpawGPc5tZgrM4ocpB1ZaPPT8+UIP
Cderwy97M0cexV9Mhe0JiaM1hgHnWEkTe8GUYQ4tQIpxXCnigVKuuZIFrAdsA0fQ
a6tE+dsT7UmjHKsdnY4G58a53Y5dimXB4NAhGmHgbg5T3IRf3qfp/Lq+rov4yTaT
XhBvsNvIRyEBWkGsWjpsOrs0mAWCDtvGPVFsfWZc9qPxYWU3aLQ03bl3FXoC4u0b
97Cxxeunyi7nfkVzGzFb2GAMk/aNlq9/5daqAqwuJEJ7iEo/ovYrHmPfgjXLx4Gp
T9JCWIEjAgMBAAECggEAD/t4lLb6KVIjo0BJSFreLxumqangnDS1SAy55IXOgFhv
9qJpPygeR4W4ZWkL4Yaa8qYtH2eno5I8fCpJYH0PTEJYfJzYnnmuQZU640Z5E1kY
orhx92/ox75AgDek0H00y3Z/TI1jLhC7HAOfEQVK6Sr7EfuBlBTMFuEZ3QbCq6OU
Fg5GrPIQqie84ZBlBk1tAQZtCAVTVKdHwlDWp41zKlVbeLya1sHId3sTL1sfmu+Q
aWLgVb643SPj4B2p2GNix2LfqKNjX4d/N8TTX1KncgRlnSKU3Vs2E7RNFI3NebW1
VM6AxiK13QoGw+eAuWfwyjLAH1WJ0l5Qr6eQb+g2AQKBgQD/mia6uTUF3wmeOSNC
CK9R5ZcMbRSLlTAGfcDk5QjzcmQ424rrQHHkzVBgHdJIzyrzznzsDc31K91FCYdo
d/eaqHSVvTd7arKFrUs/uMZUZVN2HUWDeh9XRMOnj/JfTDXvH1NQEKCP5oJb8uh6
yiZU06ALuy75sGOmtwZ0FOoCgQKBgQDOQ8uQKPDa7/TYVNiJlCrXQLnwCGXJhpmr
oADIdtGmG0Ve1MSWYM1+uwZoqFLTcmdPtYwpviqhN7SM6S70FnVE5dJi3qi9hDaB
2CwIEY9oUHbxFlE4XKRMgRDbEuKFQqCF3OgDsq1PVNNWrpATD/rCDVLwpoGvelBF
wdo5qVJpowKBgGpGPM4sTYiIaOZZmXhORh8GF9y5ye4TdKluRfKl7CfUqykc11Dj
NbfNShr8qz9Mq+49L6GyR60ltNWMlblxEAlE+1x7FQOCpIGCQSRYflX+30nf99Qn
xboyRCt6ZWsMM+ydmLVUhH3weMkkYVcUkAV7DDN0e56joXti5BMF0xqBAoGABQKw
lzfnYeoiUH7/I5ht0fzIh4QstNCIOxsP6c65GQfgj4UroVuIomN4rGIqYOiOiekn
FnyAHJp10FZ5xYQmJR5QFgbCopfrmwvdRfTnPul1ejXIk03sz87y0d+LkSElNRtA
p5ZXj23IFHr5FP12YfBg62egDtsxyAAFhREP53ECgYEAte7vRMi19p1BcLydSH+x
yE3k9ACOM4QFIGZAYj1k5yoMo3kLRE/9xp8daq+E9GkqArIZLp0kuohvShReAu2B
scnZSlEPtyQkfafF6h7I/XxQwe3QpR8qXfKhyUn7mdrDbHuvKviZdcS/g3khzVZd
UxeyoYq06nD7/VX71u1W9cc=
-----END PRIVATE KEY-----`;

async function withHttpFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  callback: (port: number) => Promise<void>,
): Promise<void> {
  const server = createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(address.port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
}

async function withHttpsFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  callback: (port: number, server: ReturnType<typeof createHttpsServer>) => Promise<void>,
): Promise<void> {
  const server = createHttpsServer({ cert: testCertificate, key: testPrivateKey }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(address.port, server);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
}

test("local-development pins the HTTP socket and verifies exact challenge proof", async () => {
  let canonicalSiteUrl = "";
  await withHttpFixture((request, response) => {
    assert.equal(request.method, "GET");
    assert.match(request.url ?? "", /^\/wp-json\/moda-interact\/v1\/connection\/challenge\?/);
    const query = new URL(request.url ?? "/", "http://localhost").searchParams;
    const responseBody = {
      attemptId,
      nonce: query.get("nonce"),
      proof: createSiteProof(secret, attemptId, query.get("nonce") ?? "", canonicalSiteUrl),
    };
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(responseBody));
  }, async (port) => {
    const site = canonicalizeWooSiteUrl(
      `http://woocommerce-sandbox.local:${port}`,
      "local-development",
    );
    canonicalSiteUrl = site.canonicalSiteUrl;
    const verifier = new WooSiteVerifier({
      mode: "local-development",
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      nonceFactory: () => nonce,
    });
    await verifier.verify(
      site,
      attemptId,
      secret,
    );
  });
});

test("connected peer validation rejects addresses outside the pinned DNS answer set", () => {
  const approved = new Set(["127.0.0.1", "2001:db8::1"]);
  assert.equal(isApprovedPeerAddress("127.0.0.1", approved), true);
  assert.equal(isApprovedPeerAddress("::ffff:127.0.0.1", approved), true);
  assert.equal(isApprovedPeerAddress("10.0.0.2", approved), false);
  assert.equal(isApprovedPeerAddress(undefined, approved), false);
});

test("challenge response identity, proof, schema and media type must match exactly", async () => {
  const cases = [
    { kind: "attempt" as const, code: "site_proof_rejected" },
    { kind: "nonce" as const, code: "site_proof_rejected" },
    { kind: "proof" as const, code: "site_proof_rejected" },
    { kind: "extra" as const, code: "site_response_rejected" },
    { kind: "media" as const, code: "site_response_rejected" },
  ];
  for (const testCase of cases) {
    let canonicalSiteUrl = "";
    await withHttpFixture((request, response) => {
      const queryNonce = new URL(request.url ?? "/", "http://localhost").searchParams.get("nonce") ?? "";
      const payload: Record<string, unknown> = {
        attemptId,
        nonce: queryNonce,
        proof: createSiteProof(secret, attemptId, queryNonce, canonicalSiteUrl),
      };
      if (testCase.kind === "attempt") payload.attemptId = "450e8400-e29b-41d4-a716-446655440000";
      if (testCase.kind === "nonce") payload.nonce = Buffer.alloc(32, 6).toString("base64url");
      if (testCase.kind === "proof") payload.proof = Buffer.alloc(32, 1).toString("base64url");
      if (testCase.kind === "extra") payload.extra = true;
      response.writeHead(200, {
        "content-type": testCase.kind === "media" ? "text/plain" : "application/json",
      });
      response.end(JSON.stringify(payload));
    }, async (port) => {
      const site = canonicalizeWooSiteUrl(`http://woocommerce-sandbox.local:${port}`, "local-development");
      canonicalSiteUrl = site.canonicalSiteUrl;
      const verifier = new WooSiteVerifier({
        mode: "local-development",
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        nonceFactory: () => nonce,
      });
      await assert.rejects(
        verifier.verify(site, attemptId, secret),
        (error: unknown) => error instanceof SiteVerificationError && error.code === testCase.code,
      );
    });
  }
});

test("public mode rejects mixed/private answers before opening a socket", async () => {
  const verifier = new WooSiteVerifier({
    mode: "public",
    resolve: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.4", family: 4 },
    ],
    nonceFactory: randomSecret,
  });
  const original = canonicalizeWooSiteUrl("https://merchant.example", "public");
  await assert.rejects(
    verifier.verify(original, attemptId, secret),
    (error: unknown) => error instanceof SiteVerificationError && error.code === "site_address_rejected",
  );
});

test("public mode rejects loopback, mapped and special-use IPv6 answers", async () => {
  for (const address of [
    "127.0.0.1", "10.0.0.1", "192.168.1.2", "100.64.0.1", "192.0.2.1",
    "::", "::ffff:127.0.0.1", "2001:db8::1", "fc00::1", "fe80::1", "ff02::1",
  ]) {
    const family = address.includes(":") ? 6 : 4;
    const verifier = new WooSiteVerifier({
      mode: "public",
      resolve: async () => [{ address, family }],
    });
    await assert.rejects(
      verifier.verify(
        canonicalizeWooSiteUrl("https://merchant.example", "public"),
        attemptId,
        secret,
      ),
      SiteVerificationError,
    );
  }
});

test("address policy distinguishes local private ranges from public/global ranges", () => {
  for (const address of ["10.2.3.4", "172.20.1.2", "192.168.1.3", "127.0.0.1", "169.254.1.1", "fc00::1", "fe80::1"]) {
    assert.equal(isLocalAddress(address), true, address);
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isLocalAddress("93.184.216.34"), false);
  assert.equal(isPublicAddress("93.184.216.34"), true);
});

test("local HTTP cannot use a globally resolved target in local-development mode", async () => {
  const verifier = new WooSiteVerifier({
    mode: "local-development",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  await assert.rejects(
    verifier.verify(
      canonicalizeWooSiteUrl("http://merchant.example", "local-development"),
      attemptId,
      secret,
    ),
    SiteVerificationError,
  );
});

test("local-development public targets retain HTTPS default-port policy", async () => {
  let nonceGenerated = false;
  const verifier = new WooSiteVerifier({
    mode: "local-development",
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    nonceFactory: () => {
      nonceGenerated = true;
      return nonce;
    },
  });
  await assert.rejects(
    verifier.verify(
      canonicalizeWooSiteUrl("https://merchant.example:8443", "local-development"),
      attemptId,
      secret,
    ),
    (error: unknown) => error instanceof SiteVerificationError && error.code === "site_address_rejected",
  );
  assert.equal(nonceGenerated, false);
});

test("local hostnames resolving publicly are rejected even when HTTPS is used", async () => {
  for (const hostname of ["localhost", "wordpress.local"]) {
    const verifier = new WooSiteVerifier({
      mode: "local-development",
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    await assert.rejects(
      verifier.verify(
        canonicalizeWooSiteUrl(`https://${hostname}`, "local-development"),
        attemptId,
        secret,
      ),
      SiteVerificationError,
    );
  }
});

test("pinned HTTPS preserves the original hostname for SNI and certificate verification", async () => {
  let canonicalSiteUrl = "";
  let serverName: string | undefined;
  await withHttpsFixture((request, response) => {
    const name = (request.socket as import("node:tls").TLSSocket).servername;
    serverName = typeof name === "string" ? name : undefined;
    const query = new URL(request.url ?? "/", "https://woocommerce-sandbox.local").searchParams;
    const responseBody = {
      attemptId,
      nonce: query.get("nonce"),
      proof: createSiteProof(secret, attemptId, query.get("nonce") ?? "", canonicalSiteUrl),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseBody));
  }, async (port) => {
    const site = canonicalizeWooSiteUrl(
      `https://woocommerce-sandbox.local:${port}`,
      "local-development",
    );
    canonicalSiteUrl = site.canonicalSiteUrl;
    const verifier = new WooSiteVerifier({
      mode: "local-development",
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      nonceFactory: () => nonce,
      ca: testCertificate,
    });
    await verifier.verify(site, attemptId, secret);
  });
  assert.equal(serverName, "woocommerce-sandbox.local");
});

test("challenge transport rejects redirects, oversized bodies and stalled servers", async () => {
  await withHttpFixture((_request, response) => {
    response.writeHead(302, { location: "http://127.0.0.1/other" });
    response.end();
  }, async (port) => {
    const verifier = new WooSiteVerifier({
      mode: "local-development",
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      nonceFactory: () => nonce,
    });
    await assert.rejects(
      verifier.verify(
        canonicalizeWooSiteUrl(`http://woocommerce-sandbox.local:${port}`, "local-development"),
        attemptId,
        secret,
      ),
      (error: unknown) => error instanceof SiteVerificationError && error.code === "site_response_rejected",
    );
  });

  await withHttpFixture((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": "4097",
    });
    response.end("{}");
  }, async (port) => {
    const verifier = new WooSiteVerifier({
      mode: "local-development",
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await assert.rejects(
      verifier.verify(
        canonicalizeWooSiteUrl(`http://woocommerce-sandbox.local:${port}`, "local-development"),
        attemptId,
        secret,
      ),
      (error: unknown) => error instanceof SiteVerificationError && error.code === "site_response_rejected",
    );
  });

  await withHttpFixture(() => undefined, async (port) => {
    const verifier = new WooSiteVerifier({
      mode: "local-development",
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      timeoutMs: 80,
    });
    const startedAt = Date.now();
    await assert.rejects(
      verifier.verify(
        canonicalizeWooSiteUrl(`http://woocommerce-sandbox.local:${port}`, "local-development"),
        attemptId,
        secret,
      ),
      (error: unknown) => error instanceof SiteVerificationError && error.code === "site_unreachable",
    );
    assert.ok(Date.now() - startedAt < 1000);
  });
});