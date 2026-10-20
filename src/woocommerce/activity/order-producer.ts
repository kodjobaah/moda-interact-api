import type { WooOrderEvent, WooOrderJob } from "./contract.js";
import {
  WooCaptureQueueProducer, wooCaptureJobId, wooCaptureContentDigest,
  type WooCaptureQueueClient,
} from "./producer.js";

export type WooOrderQueueClient = WooCaptureQueueClient<WooOrderJob>;
export interface WooOrderPublisher {
  publish(shopId: string, event: WooOrderEvent): Promise<{ duplicate: boolean; jobId: string }>;
}
export const wooOrderJobId = (shopId: string, eventId: string): string =>
  wooCaptureJobId("order", shopId, eventId);
export const wooOrderContentDigest = (event: WooOrderEvent): string =>
  wooCaptureContentDigest(event);

/** Dedicated order queue: never publish Woo orders on checkout or Shopify queues. */
export class WooOrderQueueProducer extends WooCaptureQueueProducer<WooOrderEvent>
  implements WooOrderPublisher {
  constructor(queue: WooOrderQueueClient) { super(queue, "order", "order-lifecycle"); }
}
