import { createHash } from "node:crypto";
import type { WooCheckoutEvent, WooCheckoutJob } from "./contract.js";

/** Redis persistence is injected, not embedded in the HTTP route. */
export interface WooCaptureQueueClient<Job> {
  getJob(jobId: string): Promise<{ data: { contentDigest?: unknown } } | undefined | null>;
  add(name: string, data: Job, options: {
    jobId: string;
    attempts: number;
    backoff: { type: "exponential"; delay: number };
    removeOnComplete: { age: number; count: number };
    removeOnFail: { age: number; count: number };
  }): Promise<unknown>;
}
export type WooCheckoutQueueClient = WooCaptureQueueClient<WooCheckoutJob>;
export interface WooCheckoutPublisher {
  publish(shopId: string, event: WooCheckoutEvent): Promise<{ duplicate: boolean; jobId: string }>;
}
export class WooCheckoutReplayConflict extends Error {
  constructor() { super("event_replay_conflict"); }
}

export function wooCaptureJobId(kind: "checkout" | "order", shopId: string, eventId: string): string {
  return `woo-${kind}-${createHash("sha256").update(shopId).update("\0").update(eventId).digest("hex")}`;
}
export function wooCheckoutJobId(shopId: string, eventId: string): string {
  return wooCaptureJobId("checkout", shopId, eventId);
}
export function wooCaptureContentDigest(event: object): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}
export function wooCheckoutContentDigest(event: WooCheckoutEvent): string {
  return wooCaptureContentDigest(event);
}

/** Same replay policy for separate Woo checkout/order queues: no permanent ledger. */
export class WooCaptureQueueProducer<Event extends { eventId: string }> {
  constructor(
    private readonly queue: WooCaptureQueueClient<Event & { shopId: string; contentDigest: string }>,
    private readonly kind: "checkout" | "order",
    private readonly jobName: string,
  ) {}

  async publish(shopId: string, event: Event): Promise<{ duplicate: boolean; jobId: string }> {
    const jobId = wooCaptureJobId(this.kind, shopId, event.eventId);
    const contentDigest = wooCaptureContentDigest(event);
    const existing = await this.queue.getJob(jobId);
    if (existing) return this.retainedOutcome(existing.data.contentDigest, contentDigest, jobId);

    const payload = { ...event, shopId, contentDigest };
    await this.queue.add(this.jobName, payload, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    });
    // BullMQ may return an already-retained job for concurrent identical IDs.
    const retained = await this.queue.getJob(jobId);
    if (!retained) throw new Error("woo_capture_enqueue_unverifiable");
    if (retained.data.contentDigest !== contentDigest) throw new WooCheckoutReplayConflict();
    return { duplicate: false, jobId };
  }

  private retainedOutcome(digest: unknown, expected: string, jobId: string) {
    if (digest !== expected) throw new WooCheckoutReplayConflict();
    return { duplicate: true, jobId };
  }
}

export class WooCheckoutQueueProducer extends WooCaptureQueueProducer<WooCheckoutEvent>
  implements WooCheckoutPublisher {
  constructor(queue: WooCheckoutQueueClient) { super(queue, "checkout", "checkout-updated"); }
}
