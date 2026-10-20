import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { WOO_CHECKOUT_QUEUE, WOO_ORDER_QUEUE, type WooCheckoutJob, type WooOrderJob } from "./contract.js";
import { WooCheckoutQueueProducer, type WooCheckoutPublisher } from "./producer.js";
import { WooOrderQueueProducer, type WooOrderPublisher } from "./order-producer.js";

/** One lazy Redis connection with independent, Woo-only checkout and order queues. */
export function createWooCheckoutRedisProducer(redisUrl: string | undefined): {
  publisher: WooCheckoutPublisher;
  orderPublisher: WooOrderPublisher;
  close(): Promise<void>;
} {
  let redis: Redis | undefined;
  let checkoutQueue: Queue<WooCheckoutJob> | undefined;
  let orderQueue: Queue<WooOrderJob> | undefined;
  function connection(): Redis {
    if (redis) return redis;
    const url = redisUrl?.trim();
    if (!url) throw new Error("woo_activity_redis_unavailable");
    const parsed = new URL(url);
    if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error("woo_activity_redis_invalid");
    }
    // No offline buffering: failed publication must surface to HTTP as 503.
    redis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt: number) => Math.min(attempt * 250, 2_000),
    });
    redis.on("error", () => { /* request failure is reported by Queue operations */ });
    return redis;
  }
  /** BullMQ may wait indefinitely for its first Redis ready event. Check
   * readiness before constructing a queue so unavailable Redis returns 503
   * promptly, without attempting a potentially delayed job write.
   */
  async function requireReady(): Promise<void> {
    const client = connection();
    if (client.status === "ready") return;
    await new Promise<void>((resolve, reject) => {
      const unavailable = () => new Error("woo_activity_redis_unavailable");
      const done = (error?: Error) => {
        clearTimeout(timeout);
        client.off("ready", onReady);
        client.off("end", onEnd);
        if (error) reject(error);
        else resolve();
      };
      const onReady = () => done();
      const onEnd = () => done(unavailable());
      const timeout = setTimeout(() => done(unavailable()), 2_000);
      client.once("ready", onReady);
      client.once("end", onEnd);
      if (client.status === "wait" || client.status === "end") {
        // A failed connection may be retried by the next HTTP request.
        void client.connect().catch(() => { /* failure surfaces via end/timeout */ });
      } else if (client.status === "ready") onReady();
    });
  }
  function getCheckoutQueue(): Queue<WooCheckoutJob> {
    return checkoutQueue ??= new Queue<WooCheckoutJob>(WOO_CHECKOUT_QUEUE, { connection: connection() });
  }
  function getOrderQueue(): Queue<WooOrderJob> {
    return orderQueue ??= new Queue<WooOrderJob>(WOO_ORDER_QUEUE, { connection: connection() });
  }
  const publisher = new WooCheckoutQueueProducer({
    getJob: async (id) => { await requireReady(); return getCheckoutQueue().getJob(id); },
    add: async (name, payload, options) => {
      await requireReady();
      return getCheckoutQueue().add(name, payload, options);
    },
  });
  const orderPublisher = new WooOrderQueueProducer({
    getJob: async (id) => { await requireReady(); return getOrderQueue().getJob(id); },
    add: async (name, payload, options) => {
      await requireReady();
      return getOrderQueue().add(name, payload, options);
    },
  });
  return {
    publisher,
    orderPublisher,
    async close() {
      // Stop reconnect attempts before closing queues if Redis is unavailable.
      // Otherwise BullMQ's graceful close can wait indefinitely for readiness.
      if (redis && redis.status !== "ready") redis.disconnect();
      try {
        await Promise.all([checkoutQueue?.close(), orderQueue?.close()]);
      } finally { redis?.disconnect(); }
    },
  };
}
