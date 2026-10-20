import assert from "node:assert/strict";
import test from "node:test";
import { WOO_ORDER_QUEUE, type WooOrderJob } from "../../../../src/woocommerce/activity/contract.js";
import { WooCheckoutReplayConflict } from "../../../../src/woocommerce/activity/producer.js";
import { WooOrderQueueProducer, wooOrderJobId, wooOrderContentDigest, type WooOrderQueueClient } from "../../../../src/woocommerce/activity/order-producer.js";
import { orderPlaced, orderPaid, orderCancelled } from "../../../fixtures/woocommerce/activity/order-event.js";

class OrderQueue implements WooOrderQueueClient {
  jobs = new Map<string, WooOrderJob>();
  calls = 0;
  unavailable = false;
  async getJob(jobId: string) {
    const data = this.jobs.get(jobId);
    return data ? { data } : null;
  }
  async add(name: string, data: WooOrderJob, options: Parameters<WooOrderQueueClient["add"]>[2]) {
    assert.equal(name, "order-lifecycle");
    assert.equal(options.attempts, 3);
    assert.equal(options.backoff.type, "exponential");
    if (this.unavailable) throw new Error("unavailable");
    this.calls++;
    if (!this.jobs.has(options.jobId)) this.jobs.set(options.jobId, data);
  }
}

test("three distinct events share checkout correlation without collapsing order lifecycle", async () => {
  const queue = new OrderQueue();
  const producer = new WooOrderQueueProducer(queue);
  assert.equal(WOO_ORDER_QUEUE, "woo-order-capture-v1");
  for (const event of [orderPlaced, orderPaid, orderCancelled]) {
    const result = await producer.publish("shop-a", event);
    assert.equal(result.duplicate, false);
    assert.match(result.jobId, /^woo-order-[a-f0-9]{64}$/);
    assert.equal(queue.jobs.get(result.jobId)?.shopId, "shop-a");
    assert.equal(queue.jobs.get(result.jobId)?.eventType, event.eventType);
    assert.equal(queue.jobs.get(result.jobId)?.checkoutKey, "cart-001");
    assert.equal(queue.jobs.get(result.jobId)?.order.checkoutKey, "cart-001");
    assert.equal(queue.jobs.get(result.jobId)?.contentDigest, wooOrderContentDigest(event));
  }
  assert.equal(queue.calls, 3);
  assert.equal((await producer.publish("shop-a", orderPlaced)).duplicate, true);
  assert.equal(queue.calls, 3);
  assert.notEqual(wooOrderJobId("shop-a", orderPlaced.eventId), wooOrderJobId("shop-b", orderPlaced.eventId));
  assert.equal((await producer.publish("shop-b", orderPlaced)).duplicate, false);
  assert.equal(queue.calls, 4);
  await assert.rejects(producer.publish("shop-a", {
    ...orderPlaced, order: { ...orderPlaced.order, status: "completed" },
  }), WooCheckoutReplayConflict);
});

test("a concurrent conflicting retained job is rejected after BullMQ add", async () => {
  const queue = new OrderQueue();
  queue.add = async (_name, data, options) => { queue.jobs.set(options.jobId, { ...data, contentDigest: "different" }); };
  await assert.rejects(new WooOrderQueueProducer(queue).publish("shop-a", orderPlaced), WooCheckoutReplayConflict);
});

test("queue failures are retryable and never treated as durable acceptance", async () => {
  const queue = new OrderQueue();
  const producer = new WooOrderQueueProducer(queue);
  queue.unavailable = true;
  await assert.rejects(producer.publish("shop-a", orderPaid));
  assert.equal(queue.jobs.size, 0);
  queue.unavailable = false;
  assert.equal((await producer.publish("shop-a", orderPaid)).duplicate, false);
});
