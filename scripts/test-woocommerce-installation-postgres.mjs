import { execFileSync } from "node:child_process";
import process from "node:process";

for (const suite of ["installation", "merchant-settings"]) {
  execFileSync(process.execPath, [`scripts/test-arch055-${suite}-postgres.mjs`], { stdio: "inherit" });
}
