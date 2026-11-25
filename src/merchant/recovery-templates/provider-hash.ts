import { createHash } from "node:crypto";

/** Hash of Meta-observed provider components, excluding submission examples.
 * Do not compare this hash with the separately compiled locale/source hash. */
export function providerComponentsHash(value: unknown): string {
  function canonical(input: unknown): string {
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    if (input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      return `{${Object.keys(obj).filter((key) => key !== "example").sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(",")}}`;
    }
    return JSON.stringify(input) ?? "null";
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
