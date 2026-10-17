import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runnerScripts = [
  "scripts/test-woocommerce-installation-postgres.mjs",
  "scripts/test-woocommerce-rest-read-authorization-postgres.mjs",
  "scripts/test-arch041-billing-postgres.mjs",
  "scripts/test-arch036-discount-offers-postgres.mjs",
  "scripts/test-arch041-cross-domain-postgres.mjs",
  "scripts/test-arch035-merchant-knowledge-postgres.mjs",
  "scripts/test-arch035-feature-preferences-postgres.mjs",
  "scripts/test-arch035-knowledge-upload-postgres.mjs",
] as const;

async function integrationTests(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await integrationTests(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(relative(root, path).split("\\").join("/"));
    }
  }
  return files;
}

test("every PostgreSQL integration suite has a default migration/schema harness", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const chain = packageJson.scripts["test:integration"] ?? "";
  const registrations: string[] = [];
  for (const script of runnerScripts) {
    assert.ok(chain.includes(`node ${script}`), `${script} missing from test:integration`);
    const body = await readFile(join(root, script), "utf8");
    const matches = body.matchAll(/tests\/integration\/[A-Za-z0-9_./-]+\.test\.ts/g);
    registrations.push(...Array.from(matches, ([path]) => path));
  }
  const expected = (await integrationTests(join(root, "tests/integration"))).sort();
  assert.ok(expected.length > 0, "no integration test files discovered");
  assert.deepEqual(registrations.sort(), expected,
    "all integration suites must be registered once in the default runner chain");
});
