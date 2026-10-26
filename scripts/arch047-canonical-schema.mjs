import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

const acceptedMigrations = [
  "20261023173000_arch047_whatsapp_template_audit_actions",
  "20261024133000_arch047_template_persistence",
];
const requiredModels = [
  "WhatsAppTemplateDefinition",
  "WhatsAppTemplateVariant",
  "WhatsAppTemplateMetaRegistration",
];

function migrationFile(schemaPath, migration) {
  return join(dirname(schemaPath), "migrations", migration, "migration.sql");
}

/** The migration folder alone is not proof that the schema is the accepted schema. */
export function isAcceptedArch047Schema(schemaPath) {
  try {
    if (!existsSync(schemaPath) ||
        !acceptedMigrations.every((migration) => existsSync(migrationFile(schemaPath, migration)))) {
      return false;
    }
    const schema = readFileSync(schemaPath, "utf8");
    return requiredModels.every((model) => new RegExp(`^model\\s+${model}\\s*\\{`, "m").test(schema));
  } catch {
    return false;
  }
}

/** Protect against selecting an unrelated schema with matching ARCH-047 migration names. */
export function isCompatibleMigrationLineage(apiSchema, canonicalSchema) {
  try {
    if (resolve(apiSchema) === resolve(canonicalSchema)) return true;
    const migrations = readdirSync(join(dirname(apiSchema), "migrations"), { withFileTypes: true });
    for (const migration of migrations) {
      if (!migration.isDirectory()) continue;
      const pinned = migrationFile(apiSchema, migration.name);
      if (!existsSync(pinned)) continue;
      const canonical = migrationFile(canonicalSchema, migration.name);
      if (!existsSync(canonical) || !readFileSync(pinned).equals(readFileSync(canonical))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Resolve the canonical primary checkout without assuming sibling task-worktree paths. */
function primaryWorkspaceFromGit(cwd) {
  try {
    // The first worktree is Git's primary checkout, even when this repository is
    // a submodule whose common git directory lives under its parent's .git/modules.
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const primary = output.match(/^worktree (.+)$/m)?.[1];
    return primary && basename(primary) === "moda-interact-api" ? dirname(primary) : null;
  } catch {
    return null;
  }
}

/**
 * A submodule's Git common directory lives under the parent's .git/modules,
 * even when the active API checkout is a detached, dedicated task worktree.
 * This is stronger evidence than the first entry in `git worktree list`, which
 * can itself be a task parent checkout rather than the primary Moda workspace.
 */
function workspaceFromGitCommonDir(cwd) {
  try {
    const output = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const gitDir = resolve(cwd, output);
    if (basename(gitDir) === "moda-interact-api" &&
        basename(dirname(gitDir)) === "modules" &&
        basename(dirname(dirname(gitDir))) === ".git") {
      return dirname(dirname(dirname(gitDir)));
    }
    if (basename(gitDir) === ".git" && basename(dirname(gitDir)) === "moda-interact-api") {
      return dirname(dirname(gitDir));
    }
  } catch { /* No accessible Git common directory. */ }
  return null;
}

/** The launcher stores sibling task worktrees in a known directory beside the
 * canonical primary workspace. Do not traverse or search arbitrary directories.
 */
function workspaceBesideTaskWorktree(cwd) {
  if (basename(dirname(cwd)) !== "moda-interact-workspace.worktrees" ||
      !/^ARCH-\d{3}-[A-Z]+-\d{3}$/.test(basename(cwd))) return null;
  return resolve(cwd, "../..", "moda-interact-workspace");
}

/**
 * Resolve a read-only accepted database schema for an isolated API worktree.
 * A supplied path is authoritative: a wrong override must not silently fall back.
 */
export function findAcceptedArch047Schema({
  cwd = process.cwd(),
  explicitSchema,
  workspaceRoot,
} = {}) {
  const apiSchema = resolve(cwd, "database/prisma/schema.prisma");
  const valid = (candidate) => isAcceptedArch047Schema(candidate) &&
    isCompatibleMigrationLineage(apiSchema, candidate);

  if (explicitSchema !== undefined) {
    if (typeof explicitSchema !== "string" || !explicitSchema.trim()) return null;
    const candidate = resolve(cwd, explicitSchema);
    return valid(candidate) ? candidate : null;
  }

  const candidates = [apiSchema];
  if (workspaceRoot) candidates.push(resolve(workspaceRoot, "moda-interact-database/prisma/schema.prisma"));
  const gitWorkspace = workspaceFromGitCommonDir(cwd);
  if (gitWorkspace) candidates.push(join(gitWorkspace, "moda-interact-database/prisma/schema.prisma"));
  const primaryWorkspace = primaryWorkspaceFromGit(cwd);
  if (primaryWorkspace) candidates.push(join(primaryWorkspace, "moda-interact-database/prisma/schema.prisma"));
  const siblingWorkspace = workspaceBesideTaskWorktree(cwd);
  if (siblingWorkspace) candidates.push(join(siblingWorkspace, "moda-interact-database/prisma/schema.prisma"));
  candidates.push(resolve(cwd, "../moda-interact-database/prisma/schema.prisma"));

  for (const candidate of new Set(candidates)) {
    if (valid(candidate)) return candidate;
  }
  return null;
}
