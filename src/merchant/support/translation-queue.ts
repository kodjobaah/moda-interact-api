import { Queue } from "bullmq";
import type { JobsOptions, QueueOptions } from "bullmq";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { MERCHANT_COMMUNICATIONS_QUEUE_NAME, MERCHANT_COMMUNICATIONS_JOB_NAMES,
  MERCHANT_COMMUNICATIONS_SCHEMA_VERSION } from "@modainteract/moda-interact-shared/merchant-communications";
import { createTranslationDispatchJobId } from "@modainteract/moda-interact-shared/merchant-communications/node";
import type { SupportTranslationDispatch } from "./commands.service.js";

function safeErrorDetails(error: unknown): Record<string, string | number> {
  const name = error instanceof Error ? error.name : typeof error;
  const safeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))
    .replace(/\b(?:rediss?|redis\+tls):\/\/[^\s"'<>]+/gi, "redis://[redacted]")
    .replace(/\b(password|passwd|authorization|token)=([^\s&]+)/gi, "$1=[redacted]")
    .slice(0, 500);
  const errorMessage = safeMessage(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code : undefined;
  return { errorName: name.slice(0, 80), errorMessage,
    ...(typeof code === "string" || typeof code === "number" ? { errorCode: String(code).slice(0, 80) } : {}),
    ...(cause === undefined ? {} : { errorCause: safeMessage(cause) }) };
}

type TranslationQueue = Pick<Queue, "on" | "add" | "close" | "disconnect">;
type QueueFactory = (name: string, options: QueueOptions) => TranslationQueue;

/** Reuse Shopify's published Shared job identity; never enqueue bodies or credentials. */
export class MerchantSupportTranslationDispatcher implements SupportTranslationDispatch {
  private queue: TranslationQueue | null = null;
  private lastErrorLogAt = 0;
  constructor(private readonly redisUrl: string | undefined,
    private readonly logger: Pick<StructuredLogger, "warn">,
    private readonly createQueue: QueueFactory = (name, options) => new Queue(name, options)) {}
  async enqueue(translationId: string): Promise<void> {
    const url = this.redisUrl?.trim();
    if (!url) throw new Error("translation_queue_unconfigured");
    const parsed = new URL(url);
    if (!["redis:","rediss:"].includes(parsed.protocol) || !parsed.hostname) throw new Error("translation_queue_unavailable");
    if (!this.queue) {
      const queue = this.createQueue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, {
        connection: { url, lazyConnect:true, enableOfflineQueue:false, maxRetriesPerRequest:1,
          connectTimeout:2_000, commandTimeout:2_000 },
      });
      queue.on("error", error => {
        const now = Date.now();
        if (now - this.lastErrorLogAt < 5_000) return;
        this.lastErrorLogAt = now;
        try {
          this.logger.warn("merchant.support.translation_queue.error", safeErrorDetails(error));
        } catch { /* A logger failure must not become an unhandled Queue event. */ }
      });
      this.queue = queue;
    }
    const queue = this.queue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        queue.add(MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_DISPATCH,
          {schemaVersion:MERCHANT_COMMUNICATIONS_SCHEMA_VERSION,translationId},
          {jobId:createTranslationDispatchJobId(translationId)} satisfies JobsOptions),
        new Promise<never>((_resolve,reject) => {
          timer=setTimeout(() => reject(new Error("translation_queue_timeout")),2_500);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async close(): Promise<void> {
    if (!this.queue) return;
    const queue=this.queue;
    this.queue=null;
    try { await queue.close(); } catch { await queue.disconnect(); }
  }
}
