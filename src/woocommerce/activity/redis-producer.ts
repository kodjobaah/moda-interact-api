import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { WOO_CHECKOUT_QUEUE, type WooCheckoutJob } from "./contract.js";
import { WooCheckoutQueueProducer, type WooCheckoutPublisher } from "./producer.js";

/** Lazy, optional producer: missing Redis disables only Woo capture, not merchant API reads. */
export function createWooCheckoutRedisProducer(redisUrl: string | undefined): {
  publisher: WooCheckoutPublisher;
  close(): Promise<void>;
} {
  let redis: Redis | undefined;
  let queue: Queue<WooCheckoutJob> | undefined;
  function getQueue(): Queue<WooCheckoutJob> {
    if (queue) return queue;
    const url = redisUrl?.trim();
    if (!url) throw new Error("woo_checkout_redis_unavailable");
    const parsed = new URL(url);
    if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error("woo_checkout_redis_invalid");
    }
    // Producers fail an individual request on Redis errors rather than buffering
    // it invisibly in ioredis' offline queue and reporting a premature success.
    redis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
    });
    redis.on("error", () => { /* request failure is reported by Queue operations */ });
    queue = new Queue<WooCheckoutJob>(WOO_CHECKOUT_QUEUE, { connection: redis });
    return queue;
  }
  const publisher = new WooCheckoutQueueProducer({
    getJob: (id) => getQueue().getJob(id),
    add: (name, payload, options) => getQueue().add(name, payload, options),
  });
  return {
    publisher,
    async close() {
      try { await queue?.close(); }
      finally { redis?.disconnect(); }
    },
  };
}
