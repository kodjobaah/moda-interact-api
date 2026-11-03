function safeText(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:postgres(?:ql)?|rediss?|redis\+tls):\/\/[^\s"'<>]+/gi, "[REDACTED_CONNECTION_URI]")
    .replace(/\b(?:postgres(?:ql)?_)?(password|passwd|authorization|token|secret|credential|signature|api[_-]?key|access[_-]?key)=([^\s&]+)/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

/** Bounded exception metadata for Shared logger fields; never emit raw stacks or provider objects. */
export function safeKnowledgeErrorFields(error: unknown): Record<string, string> {
  const name = error instanceof Error ? error.name : typeof error;
  const fields: Record<string, string> = {
    errorName: name.slice(0, 80),
    errorMessage: safeText(error),
  };
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    fields.errorCode = safeText(error.code).slice(0, 80);
  }
  if (error instanceof Error && error.cause !== undefined) fields.errorCause = safeText(error.cause);
  return fields;
}
