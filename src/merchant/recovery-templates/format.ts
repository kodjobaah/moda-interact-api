/** Frozen Meta components identify the format; never infer it from a template
 * name, a merchant logo URL, or a caller-supplied flag. NONE and TEXT headers
 * share the same platform fallback format. */
export const RECOVERY_TEMPLATE_FORMATS = ["TEXT", "IMAGE"] as const;
export type RecoveryTemplateFormat = typeof RECOVERY_TEMPLATE_FORMATS[number];
export type RecoveryHeaderKind = "NONE" | RecoveryTemplateFormat;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function recoveryHeaderKind(components: unknown): RecoveryHeaderKind | null {
  if (!Array.isArray(components) || !components.every(component => record(component) &&
    ["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(String(component.type)))) return null;
  if (components.filter(component => component.type === "BODY").length !== 1) return null;
  const headers = components.filter(component => component.type === "HEADER");
  if (!headers.length) return "NONE";
  if (headers.length !== 1) return null;
  const kind = headers[0]!.format;
  return kind === "TEXT" || kind === "IMAGE" ? kind : null;
}

export function recoveryTemplateFormat(components: unknown): RecoveryTemplateFormat | null {
  const kind = recoveryHeaderKind(components);
  return kind === null ? null : kind === "IMAGE" ? "IMAGE" : "TEXT";
}

/** The default TEXT fallback must not depend on ShopBrand, including URL/text
 * bindings, not merely omit the image header. */
export function isBrandIndependentText(bindings: unknown): boolean {
  if (!record(bindings) || bindings.headerMediaRole !== undefined) return false;
  return [bindings.header ?? [], bindings.body, bindings.buttons].every(group =>
    Array.isArray(group) && group.every(binding => record(binding) &&
      typeof binding.variable === "string" && !binding.variable.startsWith("shopBrand.")));
}

export function validImageRole(bindings: unknown): string | null {
  if (!record(bindings) || !Array.isArray(bindings.header) || bindings.header.length) return null;
  const role = bindings.headerMediaRole;
  return typeof role === "string" && ["LOGO", "SQUARE_LOGO", "COVER_IMAGE", "CHECKOUT_PRODUCT"].includes(role) ? role : null;
}
