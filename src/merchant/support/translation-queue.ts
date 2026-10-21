import { Queue } from "bullmq";
import { MERCHANT_COMMUNICATIONS_QUEUE_NAME, MERCHANT_COMMUNICATIONS_JOB_NAMES,
  MERCHANT_COMMUNICATIONS_SCHEMA_VERSION } from "@modainteract/moda-interact-shared/merchant-communications";
import { createTranslationDispatchJobId } from "@modainteract/moda-interact-shared/merchant-communications/node";
import type { SupportTranslationDispatch } from "./commands.service.js";

/** Reuse Shopify's published Shared job identity; never enqueue bodies or credentials. */
export class MerchantSupportTranslationDispatcher implements SupportTranslationDispatch {
  private queue: Queue | null = null;
  constructor(private readonly redisUrl: string | undefined) {}
  async enqueue(translationId: string): Promise<void> {
    const url = this.redisUrl?.trim();
    if (!url) throw new Error("translation_queue_unconfigured");
    const parsed = new URL(url);
    if (!["redis:","rediss:"].includes(parsed.protocol) || !parsed.hostname) throw new Error("translation_queue_unavailable");
    if (!this.queue) {
      const queue = new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, {
        connection: { url, lazyConnect:true, enableOfflineQueue:false, maxRetriesPerRequest:1,
          connectTimeout:2_000, commandTimeout:2_000 },
      });
      queue.on("error", () => { /* Failure is surfaced with a bounded error code by the API. */ });
      this.queue = queue;
    }
    const queue = this.queue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        queue.add(MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_DISPATCH,
          {schemaVersion:MERCHANT_COMMUNICATIONS_SCHEMA_VERSION,translationId},
          {jobId:createTranslationDispatchJobId(translationId)}),
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
