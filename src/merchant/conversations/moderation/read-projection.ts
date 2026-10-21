/** Safe public moderation projection shared by recovery transcript and command reads.
 * Provider category names/scores, internal diagnostics and model IDs are not exposed.
 */
export type PublicModerationDecision = "PENDING" | "ALLOW" | "BLOCK" | "REVIEW_REQUIRED" | "RETRYABLE_ERROR";

export function publicModerationDecision(persisted: string | null): PublicModerationDecision {
  switch (persisted) {
    case "ALLOW": case "BLOCK": case "REVIEW_REQUIRED": case "RETRYABLE_ERROR": return persisted;
    default: return "PENDING";
  }
}

export function publicModerationReason(decision: PublicModerationDecision, reason: string | null): string | null {
  if (decision === "ALLOW" || decision === "PENDING") return null;
  if (decision === "BLOCK") return "moderation_blocked";
  if (decision === "RETRYABLE_ERROR") return "moderation_unavailable";
  if (reason === "moderation_empty_input") return "moderation_empty_input";
  if (reason === "moderation_dependency_unavailable") return "moderation_unavailable";
  return "moderation_review_required";
}
