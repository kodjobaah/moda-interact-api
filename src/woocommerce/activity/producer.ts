import { createHash } from "node:crypto";
import type { WooCheckoutEvent, WooCheckoutJob } from "./contract.js";

/** An intentionally narrow interface: Redis persistence is injected, not embedded in the route. */
export interface WooCheckoutQueueClient {
  getJob(jobId: string): Promise<{ data: { contentDigest?: unknown } } | undefined | null>;
  add(name: string, data: WooCheckoutJob, options: {
    jobId: string;
    attempts: number;
    backoff: { type: "exponential"; delay: number };
    removeOnComplete: { age: number; count: number };
    removeOnFail: { age: number; count: number };
  }): Promise<unknown>;
}
export interface WooCheckoutPublisher {
  publish(shopId: string, event: WooCheckoutEvent): Promise<{ duplicate: boolean; jobId: string }>;
}
export class WooCheckoutReplayConflict extends Error {
  constructor() { super("event_replay_conflict"); }
}

export function wooCheckoutJobId(shopId: string, eventId: string): string {
  return `woo-checkout-${createHash("sha256").update(shopId).update("\0").update(eventId).digest("hex")}`;
}
export function wooCheckoutContentDigest(event: WooCheckoutEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

export class WooCheckoutQueueProducer implements WooCheckoutPublisher {
  constructor(private readonly queue: WooCheckoutQueueClient) {}

  async publish(shopId: string, event: WooCheckoutEvent): Promise<{ duplicate: boolean; jobId: string }> {
    const jobId = wooCheckoutJobId(shopId, event.eventId);
    const contentDigest = wooCheckoutContentDigest(event);
    const existing = await this.queue.getJob(jobId);
    if (existing) return this.retainedOutcome(existing.data.contentDigest, contentDigest, jobId);

    const payload: WooCheckoutJob = { ...event, shopId, contentDigest };
    await this.queue.add("checkout-updated", payload, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    });
    // After add, inspect the retained job again. This catches concurrent conflicting
    // writers even when BullMQ returns the existing job rather than inserting ours.
    const retained = await this.queue.getJob(jobId);
    if (!retained) throw new Error("woo_checkout_enqueue_unverifiable");
    if (retained.data.contentDigest !== contentDigest) throw new WooCheckoutReplayConflict();
    return { duplicate: false, jobId };
  }

  private retainedOutcome(digest: unknown, expected: string, jobId: string) {
    if (digest !== expected) throw new WooCheckoutReplayConflict();
    return { duplicate: true, jobId };
  }
}
