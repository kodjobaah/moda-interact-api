import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directRunners = [
  "scripts/test-woocommerce-installation-postgres.mjs",
  "scripts/test-woocommerce-rest-read-authorization-postgres.mjs",
  "scripts/test-arch041-billing-postgres.mjs",
  "scripts/test-arch036-discount-offers-postgres.mjs",
  "scripts/test-arch041-cross-domain-postgres.mjs",
  "scripts/test-arch035-merchant-knowledge-postgres.mjs",
  "scripts/test-arch035-feature-preferences-postgres.mjs",
  "scripts/test-arch035-promotions-postgres.mjs",
  "scripts/test-arch035-woo-support-postgres.mjs",
  "scripts/test-arch035-usage-history-postgres.mjs",
  "scripts/test-arch035-knowledge-upload-postgres.mjs",
  "scripts/run-arch043-platform-configuration-postgres.mjs",
] as const;

// These disposable runners are included transitively through npm scripts.
const delegatedRunners = [
  { npmScript: "test:arch040-conversation-control:postgres", runner: "scripts/test-arch040-woo-conversation-control-postgres.mjs" },
  { npmScript: "test:arch040-human-send:postgres", runner: "scripts/test-arch040-woo-human-send-postgres.mjs" },
  { npmScript: "test:arch035-woo-activity:redis", runner: "scripts/test-arch035-woo-activity-redis.mjs" },
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

test("every integration suite is registered once in the default disposable runner chain", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const chain = packageJson.scripts["test:integration"] ?? "";
  const registrations: string[] = [];
  const register = async (runner: string) => {
    const body = await readFile(join(root, runner), "utf8");
    const matches = body.matchAll(/tests\/integration\/[A-Za-z0-9_./-]+\.test\.ts/g);
    registrations.push(...Array.from(matches, ([path]) => path));
  };
  for (const runner of directRunners) {
    assert.ok(chain.includes(`node ${runner}`), `${runner} missing from test:integration`);
    await register(runner);
  }
  for (const { npmScript, runner } of delegatedRunners) {
    assert.ok(chain.includes(`npm run ${npmScript}`), `${npmScript} missing from test:integration`);
    assert.ok((packageJson.scripts[npmScript] ?? "").includes(`node ${runner}`),
      `${npmScript} must invoke ${runner}`);
    await register(runner);
  }
  const expected = (await integrationTests(join(root, "tests/integration"))).sort();
  assert.ok(expected.length > 0, "no integration test files discovered");
  assert.deepEqual(registrations.sort(), expected,
    "all integration suites must be registered once in the default runner chain");
});
