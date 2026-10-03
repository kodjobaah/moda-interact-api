import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import {
  AUTH_PROBE_ROUTE_PATH,
  CONNECT_REQUEST_FIELDS,
  CONNECT_ROUTE_PATH,
  MAX_CONNECT_BODY_BYTES,
  MAX_SITE_URL_BYTES,
} from "./routes.js";

test("OpenAPI v1 matches the installation route paths, request limits and response contracts", async () => {
  const contractPath = new URL("../../../openapi/woocommerce-installation-v1.yaml", import.meta.url);
  const document = parse(await readFile(fileURLToPath(contractPath), "utf8")) as OpenApiDocument;
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(document.paths).sort(), [AUTH_PROBE_ROUTE_PATH, CONNECT_ROUTE_PATH].sort());

  const connect = document.paths[CONNECT_ROUTE_PATH]?.post;
  assert.ok(connect);
  const requestSchema = document.components.schemas.ConnectRequest;
  assert.ok(requestSchema);
  assert.equal(requestSchema.type, "object");
  assert.equal(requestSchema.additionalProperties, false);
  assert.deepEqual(requestSchema.required, [...CONNECT_REQUEST_FIELDS]);
  assert.deepEqual(Object.keys(requestSchema.properties ?? {}).sort(), [...CONNECT_REQUEST_FIELDS].sort());
  assert.equal(requestSchema.properties?.siteUrl?.maxLength, MAX_SITE_URL_BYTES);
  assert.equal(requestSchema["x-max-body-bytes"], MAX_CONNECT_BODY_BYTES);
  assert.deepEqual(Object.keys(connect.responses).sort(), ["200", "201", "400", "409", "413", "422", "500"]);

  const connectResponse = document.components.schemas.ConnectResponse;
  assert.ok(connectResponse);
  assert.deepEqual(Object.keys(connectResponse.properties ?? {}).sort(), [
    "canonicalSiteUrl", "connection", "credential", "credentialVersion", "installationId", "shopId",
  ]);
  const probe = document.paths[AUTH_PROBE_ROUTE_PATH]?.get;
  assert.ok(probe);
  assert.deepEqual(Object.keys(probe.responses).sort(), ["200", "401", "500"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(connect.responses).filter(([status]) => Number(status) >= 400).map(([status, response]) => [status, responseCode(document, response)])),
    { "400": "invalid_request", "409": "connection_conflict", "413": "request_too_large", "422": "site_verification_failed", "500": "internal_error" },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(probe.responses).filter(([status]) => Number(status) >= 400).map(([status, response]) => [status, responseCode(document, response)])),
    { "401": "unauthorized", "500": "internal_error" },
  );
  const principal = document.components.schemas.InstallationPrincipal;
  assert.ok(principal);
  assert.deepEqual(Object.keys(principal.properties ?? {}).sort(), [
    "canonicalSiteUrl", "credentialVersion", "installationId", "shopId",
  ]);
  assert.deepEqual(probe.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
  const siteChallenge = document.components.schemas.SiteChallenge;
  assert.ok(siteChallenge);
  assert.equal(siteChallenge.additionalProperties, false);
  assert.equal(document.info["x-woocommerce-site-challenge"].method, "GET");
  assert.equal(document.info["x-woocommerce-site-challenge"].path, "/wp-json/moda-interact/v1/connection/challenge");
  assert.equal(document.info["x-woocommerce-site-challenge"].proof.algorithm, "HMAC-SHA256");
  assert.equal(document.info["x-woocommerce-site-challenge"].transport.redirects, "forbidden");
});

interface OpenApiDocument {
  openapi: string;
  info: {
    "x-woocommerce-site-challenge": {
      method: string;
      path: string;
      proof: { algorithm: string };
      transport: { redirects: string };
    };
  };
  paths: Record<string, {
    post?: { responses: Record<string, unknown> };
    get?: { responses: Record<string, unknown>; security?: Array<Record<string, string[]>> };
  }>;
  components: {
    responses: Record<string, {
      content?: { "application/json"?: { schema?: { $ref?: string } } };
    }>;
    schemas: Record<string, {
      allOf?: Array<{ $ref?: string; properties?: Record<string, { const?: string }> }>;
      type?: string;
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, { maxLength?: number }>;
      "x-max-body-bytes"?: number;
    }>;
  };
}

function responseCode(document: OpenApiDocument, response: unknown): string | undefined {
  if (!response || typeof response !== "object" || !("$ref" in response)) return undefined;
  const responseName = String(response.$ref).split("/").at(-1) ?? "";
  const schemaRef = document.components.responses[responseName]?.content?.["application/json"]?.schema?.$ref;
  const schemaName = schemaRef?.split("/").at(-1) ?? "";
  const schema = document.components.schemas[schemaName];
  return schema?.allOf?.flatMap((part) => Object.values(part.properties ?? {})).find((property) => property.const !== undefined)?.const;
}