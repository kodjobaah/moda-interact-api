import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { WOO_READ_CALLBACK_PREFIX, WOO_READ_RETURN_PATH, WOO_READ_START_PATH, WOO_READ_STATUS_PATH } from "./authorization.routes.js";

test("Woo REST read authorization OpenAPI v1 is versioned and matches all four routes", async () => {
  const contract = parse(await readFile(new URL("../../../openapi/woocommerce-read-authorization-v1.yaml", import.meta.url), "utf8")) as {
    openapi: string;
    paths: Record<string, Record<string, { security?: unknown; requestBody?: { "x-max-body-bytes"?: number } }>>;
    components: { schemas: { CallbackPayload: { properties: Record<string, { const?: string }> } } };
  };
  assert.equal(contract.openapi, "3.1.0");
  assert.deepEqual(Object.keys(contract.paths).sort(), [WOO_READ_START_PATH, WOO_READ_STATUS_PATH,
    `${WOO_READ_CALLBACK_PREFIX}{opaqueAttemptToken}`, WOO_READ_RETURN_PATH].sort());
  assert.ok(contract.paths[WOO_READ_START_PATH]?.post?.security);
  assert.ok(contract.paths[WOO_READ_STATUS_PATH]?.delete?.security);
  assert.equal(contract.paths[`${WOO_READ_CALLBACK_PREFIX}{opaqueAttemptToken}`]?.post?.requestBody?.["x-max-body-bytes"], 4096);
  assert.equal(contract.components.schemas.CallbackPayload.properties.key_permissions?.const, "read");
});
