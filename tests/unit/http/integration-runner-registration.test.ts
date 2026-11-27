import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directRunners = [
  "scripts/test-arch049-shop-brand-postgres.mjs",
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
  "scripts/test-arch053-recovery-restore-postgres.mjs",
  "scripts/test-arch054-ai-response-delay-postgres.mjs",
] as const;

// These disposable runners are included transitively through npm scripts.
const delegatedRunners = [
  { npmScript: "test:arch055-readiness:postgres", runner: "scripts/test-arch055-readiness-postgres.mjs" },
  { npmScript: "test:arch040-conversation-control:postgres", runner: "scripts/test-arch040-woo-conversation-control-postgres.mjs" },
  { npmScript: "test:arch040-human-send:postgres", runner: "scripts/test-arch040-woo-human-send-postgres.mjs" },
  { npmScript: "test:arch046-woo-consent:postgres", runner: "scripts/test-arch046-woo-consent-postgres.mjs" },
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

async function collectRunnerRegistrations(
  runner: string,
  readRunner: (runner: string) => Promise<string>,
  ancestors: readonly string[] = [],
): Promise<string[]> {
  const lineage = [...ancestors, runner];
  assert.ok(!ancestors.includes(runner), `cyclic integration runner reference: ${lineage.join(" -> ")}`);
  const body = await readRunner(runner);
  const matches = body.matchAll(/tests\/integration\/[A-Za-z0-9_./-]+\.test\.ts/g);
  // Measurement runners may reference the same suite for candidate and baseline passes.
  const registrations = [...new Set(Array.from(matches, ([path]) => path))];
  for (const match of body.matchAll(/scripts\/[A-Za-z0-9_./-]+\.mjs/g)) {
    const [nestedRunner] = match;
    // A usage diagnostic may print its own command; that is not a delegation.
    if (nestedRunner === runner && body.slice(0, match.index).endsWith("Usage: node ")) continue;
    registrations.push(...await collectRunnerRegistrations(nestedRunner, readRunner, lineage));
  }
  return registrations;
}

function fixtureReader(bodies: Record<string, string>): (runner: string) => Promise<string> {
  return async runner => {
    const body = bodies[runner];
    assert.ok(body !== undefined, `missing fixture runner: ${runner}`);
    return body;
  };
}

test("runner registration ignores its own usage diagnostic but follows delegated runners", async () => {
  const runner = "scripts/root.mjs";
  const nested = "scripts/leaf.mjs";
  const readRunner = fixtureReader({
    [runner]: `throw new Error("Usage: node ${runner} [--optional]"); const suites = ["tests/integration/root.test.ts"]; const delegate = "${nested}";`,
    [nested]: 'const suites = ["tests/integration/leaf.test.ts"];',
  });
  assert.deepEqual(await collectRunnerRegistrations(runner, readRunner), [
    "tests/integration/root.test.ts", "tests/integration/leaf.test.ts",
  ]);
});

test("runner registration rejects actual self references and indirect cycles", async () => {
  const runner = "scripts/root.mjs";
  const nested = "scripts/leaf.mjs";
  await assert.rejects(collectRunnerRegistrations(runner, fixtureReader({
    [runner]: `const delegate = "${runner}";`,
  })), /cyclic integration runner reference/);
  await assert.rejects(collectRunnerRegistrations(runner, fixtureReader({
    [runner]: `const delegate = "${nested}";`,
    [nested]: `const delegate = "${runner}";`,
  })), /cyclic integration runner reference/);
});

test("runner registration preserves duplicate suite ownership across different runners", async () => {
  const runner = "scripts/root.mjs";
  const suite = "tests/integration/shared.test.ts";
  const readRunner = fixtureReader({
    [runner]: `const delegates = ["scripts/first.mjs", "scripts/second.mjs"];`,
    "scripts/first.mjs": `const suites = ["${suite}", "${suite}"];`,
    "scripts/second.mjs": `const suites = ["${suite}"];`,
  });
  assert.deepEqual(await collectRunnerRegistrations(runner, readRunner), [suite, suite]);
});

test("every integration suite has a disposable runner or explicit PHP contract command", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const chain = packageJson.scripts["test:integration"] ?? "";
  const registrations: string[] = [];
  const register = async (runner: string) => {
    registrations.push(...await collectRunnerRegistrations(runner, path => readFile(join(root, path), "utf8")));
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
  const phpContract = "tests/integration/woocommerce/consent-status/php-client-contract.test.ts";
  assert.ok(packageJson.scripts["test:arch046-woo-consent-status:php"]?.includes(phpContract));
  registrations.push(phpContract);
  const expected = (await integrationTests(join(root, "tests/integration"))).sort();
  assert.ok(expected.length > 0, "no integration test files discovered");
  assert.deepEqual(registrations.sort(), expected,
    "all integration suites must have one owning runner or explicit contract command");
});
