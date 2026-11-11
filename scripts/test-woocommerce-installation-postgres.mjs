import { execFileSync } from "node:child_process";
import process from "node:process";

for (const runner of [
  "scripts/test-arch055-installation-postgres.mjs",
  "scripts/test-arch055-merchant-settings-postgres.mjs",
]) {
  execFileSync(process.execPath, [runner], { stdio: "inherit" });
}
