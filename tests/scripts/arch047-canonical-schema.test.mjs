import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  findAcceptedArch047Schema,
  isAcceptedArch047Schema,
  isCompatibleMigrationLineage,
} from "../../scripts/arch047-canonical-schema.mjs";

const baselineMigration = "20261018092000_arch040_moderation_template_content_digest";
const requiredMigrations = [
  "20261023173000_arch047_whatsapp_template_audit_actions",
  "20261024133000_arch047_template_persistence",
];

function writeMigration(schemaPath, name, sql = `-- accepted ${name}\n`) {
  const file = join(dirname(schemaPath), "migrations", name, "migration.sql");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, sql);
}

function fixture(t, { withGit = false, primaryIsTask = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "moda-api-arch047-schema-"));
  const primary = join(root, primaryIsTask ? "moda-interact-workspace-task-ARCH-047-API-001" :
    "moda-interact-workspace", "moda-interact-api");
  const canonical = join(root, "moda-interact-workspace", "moda-interact-database", "prisma", "schema.prisma");
  const pinned = join(primary, "database", "prisma", "schema.prisma");
  const task = join(root, "moda-interact-workspace.worktrees", "ARCH-047-API-001");
  t.after(() => {
    if (withGit) {
      try { execFileSync("git", ["worktree", "remove", "--force", task], { cwd: primary, stdio: "ignore" }); }
      catch { /* Temp fixture may have failed before creating its worktree. */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(dirname(pinned), { recursive: true });
  mkdirSync(dirname(canonical), { recursive: true });
  writeFileSync(pinned, "model Shop { id String @id }\n");
  writeMigration(pinned, baselineMigration);
  writeFileSync(canonical, [
    "model WhatsAppTemplateDefinition { id String @id }",
    "model WhatsAppTemplateVariant { id String @id }",
    "model WhatsAppTemplateMetaRegistration { id String @id }",
  ].join("\n") + "\n");
  writeMigration(canonical, baselineMigration);
  for (const migration of requiredMigrations) writeMigration(canonical, migration);
  if (withGit) {
    const git = (args) => execFileSync("git", args, { cwd: primary, stdio: "ignore" });
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "-q", "--allow-empty", "-m", "initial"]);
    mkdirSync(dirname(task), { recursive: true });
    git(["worktree", "add", "--detach", task]);
    // The pinned API submodule contents are visible under the linked worktree.
    const taskPinned = join(task, "database", "prisma", "schema.prisma");
    mkdirSync(dirname(taskPinned), { recursive: true });
    writeFileSync(taskPinned, readFileSync(pinned));
    writeMigration(taskPinned, baselineMigration);
  }
  return { root, primary, task, pinned, canonical };
}

test("finds accepted canonical schema from Git's primary API checkout in a task worktree", (t) => {
  const { task, canonical } = fixture(t, { withGit: true });
  assert.equal(realpathSync(findAcceptedArch047Schema({ cwd: task })), realpathSync(canonical));
  assert.equal(isAcceptedArch047Schema(canonical), true);
});

test("finds the canonical sibling workspace when the API primary checkout belongs to a task parent", (t) => {
  const { task, canonical } = fixture(t, { withGit: true, primaryIsTask: true });
  assert.equal(realpathSync(findAcceptedArch047Schema({ cwd: task })), realpathSync(canonical));
});

test("does not infer canonical workspace paths outside a known task worktree", (t) => {
  const { root, primary } = fixture(t);
  assert.equal(findAcceptedArch047Schema({ cwd: join(root, "unrelated", "ARCH-047-API-001") }), null);
  assert.equal(findAcceptedArch047Schema({ cwd: primary, explicitSchema: "" }), null);
});

test("prefers a fully updated API database submodule without needing sibling sources", (t) => {
  const { primary, pinned, canonical } = fixture(t);
  writeFileSync(pinned, readFileSync(canonical));
  for (const migration of requiredMigrations) writeMigration(pinned, migration);
  assert.equal(findAcceptedArch047Schema({ cwd: primary }), pinned);
});

test("explicit schema override is authoritative and fails closed when wrong", (t) => {
  const { primary, pinned, canonical } = fixture(t);
  assert.equal(findAcceptedArch047Schema({ cwd: primary, explicitSchema: canonical }), canonical);
  assert.equal(findAcceptedArch047Schema({ cwd: primary, explicitSchema: pinned }), null);
  assert.equal(findAcceptedArch047Schema({ cwd: primary, explicitSchema: "" }), null);
});

test("rejects mismatched baseline migration lineage despite ARCH-047 markers", (t) => {
  const { primary, canonical, pinned } = fixture(t);
  writeMigration(canonical, baselineMigration, "-- DIFFERENT baseline\n");
  assert.equal(isAcceptedArch047Schema(canonical), true);
  assert.equal(isCompatibleMigrationLineage(pinned, canonical), false);
  assert.equal(findAcceptedArch047Schema({ cwd: primary, explicitSchema: canonical }), null);
});

test("rejects schema with missing model or required audit migration", (t) => {
  const { canonical } = fixture(t);
  assert.equal(isAcceptedArch047Schema(canonical), true);
  writeFileSync(canonical, "model WhatsAppTemplateDefinition { id String @id }\n");
  assert.equal(isAcceptedArch047Schema(canonical), false);
});
