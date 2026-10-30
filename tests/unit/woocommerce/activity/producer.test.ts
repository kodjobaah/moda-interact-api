import assert from "node:assert/strict";
import test from "node:test";
import { WOO_CHECKOUT_QUEUE, parseWooActivityEvent, type WooCheckoutJob } from "../../../../src/woocommerce/activity/contract.js";
import {
  WooCheckoutQueueProducer, WooCheckoutReplayConflict, wooCheckoutJobId, wooCheckoutContentDigest,
  type WooCheckoutQueueClient,
} from "../../../../src/woocommerce/activity/producer.js";
import { event } from "../../../fixtures/woocommerce/activity/checkout-event.js";

class InMemoryQueue implements WooCheckoutQueueClient {
  jobs = new Map<string, WooCheckoutJob>();
  adds = 0;
  fail = false;
  async getJob(id: string) {
    const data = this.jobs.get(id);
    return data ? { data } : null;
  }
  async add(name: string, data: WooCheckoutJob, options: Parameters<WooCheckoutQueueClient["add"]>[2]) {
    assert.equal(name, "checkout-updated");
    assert.equal(options.attempts, 3);
    assert.equal(options.removeOnComplete.age, 86_400);
    if (this.fail) throw new Error("Redis SECRET redis://private.example");
    this.adds++;
    if (!this.jobs.has(options.jobId)) this.jobs.set(options.jobId, data);
  }
}

test("Woo-only queue identity and retained replay protect tenant/event boundaries", async () => {
  const queue = new InMemoryQueue();
  const producer = new WooCheckoutQueueProducer(queue);
  assert.equal(WOO_CHECKOUT_QUEUE, "woo-checkout-capture-v1");
  const first = await producer.publish("shop-a", event);
  assert.equal(first.duplicate, false);
  assert.match(first.jobId, /^woo-checkout-[a-f0-9]{64}$/);
  assert.equal(queue.jobs.get(first.jobId)?.shopId, "shop-a");
  assert.equal(queue.jobs.get(first.jobId)?.contentDigest, wooCheckoutContentDigest(event));
  assert.equal((await producer.publish("shop-a", event)).duplicate, true);
  assert.equal(queue.adds, 1);
  assert.equal(wooCheckoutJobId("shop-a", event.eventId), first.jobId);
  assert.notEqual(wooCheckoutJobId("shop-b", event.eventId), first.jobId);
  assert.equal((await producer.publish("shop-b", event)).duplicate, false);
  assert.equal(queue.adds, 2);
  await assert.rejects(producer.publish("shop-a", { ...event, checkout: {
    ...event.checkout, total: "19.99",
  } }), WooCheckoutReplayConflict);
  assert.equal(queue.adds, 2);
});

test("race with conflicting retained job is detected after add, no accidental overwrite", async () => {
  const queue = new InMemoryQueue();
  const producer = new WooCheckoutQueueProducer(queue);
  queue.add = async (_name, data, opts) => {
    queue.jobs.set(opts.jobId, { ...data, contentDigest: "conflicting" });
  };
  await assert.rejects(producer.publish("shop-a", event), WooCheckoutReplayConflict);
});

test("restoration is retained in the v1 queue job, digest, and replay conflict check", async () => {
  const queue = new InMemoryQueue();
  const producer = new WooCheckoutQueueProducer(queue);
  const request = {
    ...event,
    checkout: {
      ...event.checkout,
      contact: { phone: "+447400123456", canonicalPhone: "447400123456", verifiedCountryCode: "GB" },
      restoration: {
        schemaVersion: "woo.cart-restore.v1",
        kind: "supported",
        appliedCouponCodes: ["Original-Code", "FREESHIP"],
        lines: [{ productId: "101", quantity: 2, attributes: { attribute_pa_color: "navy" } }],
      },
    },
  };
  const normalized = parseWooActivityEvent(request);
  if (normalized.eventType !== "CHECKOUT_UPDATED") throw new Error("expected checkout");
  const accepted = await producer.publish("shop-a", normalized);
  const job = queue.jobs.get(accepted.jobId);
  assert.ok(job);
  assert.equal(job.schemaVersion, "woo.activity.v1");
  assert.deepEqual(job.checkout.restoration, request.checkout.restoration);
  assert.deepEqual(job.checkout.contact, { phone: "+447400123456" });
  assert.equal(job.contentDigest, wooCheckoutContentDigest(normalized));
  assert.equal((await producer.publish("shop-a", normalized)).duplicate, true);

  const changed = parseWooActivityEvent({ ...request, checkout: { ...request.checkout,
    restoration: { ...request.checkout.restoration, appliedCouponCodes: ["Changed-Code"] },
  } });
  if (changed.eventType !== "CHECKOUT_UPDATED") throw new Error("expected checkout");
  await assert.rejects(producer.publish("shop-a", changed), WooCheckoutReplayConflict);
  assert.equal(queue.adds, 1);
});

test("queue unavailable rejects rather than acknowledging and retry can then succeed", async () => {
  const queue = new InMemoryQueue();
  const producer = new WooCheckoutQueueProducer(queue);
  queue.fail = true;
  await assert.rejects(producer.publish("shop-a", event));
  assert.equal(queue.jobs.size, 0);
  queue.fail = false;
  await producer.publish("shop-a", event);
  assert.equal(queue.jobs.size, 1);
});
