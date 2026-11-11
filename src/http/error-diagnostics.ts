import { sanitizeLogFields } from "@modainteract/moda-interact-shared/logging";

/** Map the route's wrapper/database cause to explicit Shared log fields.
 * Shared owns Error serialization and bounds; raw stacks, query/meta payloads
 * are never projected. Database text needs boundary-specific redaction first.
 */
export function safeErrorDiagnostic(error: unknown) {
  if (!(error instanceof Error)) return sanitizeLogFields({ errorType: typeof error });
  const cause = error.cause instanceof Error ? error.cause : undefined;
  const databaseError = cause ?? error;
  const code = "code" in databaseError ? databaseError.code : undefined;
  const fields = sanitizeLogFields({
    error,
    ...(cause ? { errorCause: cause } : {}),
    ...(typeof code === "string" && /^(?:P\d{4}|[0-9A-Z]{5})$/.test(code) ? { databaseCode: code } : {}),
  });
  let redactionApplied = false;
  for (const [key, original] of [["error", error], ["errorCause", cause]] as const) {
    if (!original) continue;
    const redact = (text: string) => text
      // Prisma renders arguments/code frames before its originating reason.
      // Only retain an unindented final reason line for these database failures;
      // quoted arguments, numbered source lines and unknown layouts stay private.
      .replace(/\bInvalid[\s\S]*?\binvocation\b[\s\S]*/gi, invocation => {
        const reasonPattern = code === "P2003"
          ? /(?:^|\n)(Foreign key constraint (?:violated|failed)[^\r\n]*)\r?\n?$/
          : code === "P2002"
            ? /(?:^|\n)(Unique constraint failed[^\r\n]*)\r?\n?$/
            : code === "P2034"
              ? /(?:^|\n)(Transaction failed due to a write conflict or a deadlock[^\r\n]*)\r?\n?$/
              : undefined;
        const reason = reasonPattern?.exec(invocation)?.[1];
        if (!reason) return "[REDACTED]";
        const preamble = invocation.slice(0, invocation.lastIndexOf(reason));
        const header = /^Invalid[^\r\n]*\binvocation(?::| in\r?\n[^\r\n]+)\r?\n/.exec(preamble);
        if (!header) return "[REDACTED]";
        const context = preamble.slice(header[0].length);
        // Prisma emits either no context, a completed argument block followed
        // by a blank line, or numbered source lines immediately before reason.
        const complete = /^\s*$/.test(context)
          || /(?:^|\n)[ \t]*(?:\}\)?|\))[ \t]*\r?\n[ \t]*\r?\n$/.test(context)
          || /^(?:[ \t]*\r?\n)*(?:[ \t]*(?:→[ \t]*)?\d+[ \t]+[^\r\n]*\r?\n)+$/.test(context);
        return complete ? `[REDACTED]\n${reason}` : "[REDACTED]";
      })
      .replace(/\b(?:detail|context|query|parameters?|payload|customer)\s*[:=][\s\S]*/gi, "[REDACTED]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[REDACTED]")
      .replace(/\b(?:password|passwd|secret|credential|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|api[_-]?key|signature)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED]")
      .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[REDACTED]")
      .replace(/\+?\d(?:[\d ().-]{5,}\d)/g, "[REDACTED]")
      .replace(/\b(?:secret|credential|password|token|authorization)\b/gi, "[REDACTED]");
    const name = redact(original.name);
    const message = redact(original.message);
    redactionApplied ||= name !== original.name || message !== original.message;
    // Redact original text before Shared truncation, including sensitive text
    // crossing its string boundary. Do not mutate the original exception.
    fields[key] = sanitizeLogFields({ ...fields[key] as Record<string, unknown>, name, message });
  }
  return sanitizeLogFields({ ...fields, redactionApplied });
}

