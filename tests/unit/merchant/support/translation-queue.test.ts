import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { MerchantSupportTranslationDispatcher } from "../../../../src/merchant/support/translation-queue.js";

test("Queue error events preserve bounded cause while redacting Redis credentials", async () => {
  const events: Array<{ name: string; fields: Record<string, unknown> }> = [];
  const queue = new EventEmitter() as EventEmitter & {
    add: () => Promise<void>; close: () => Promise<void>; disconnect: () => Promise<void>;
  };
  queue.add = async () => undefined;
  queue.close = async () => undefined;
  queue.disconnect = async () => undefined;
  const dispatcher = new MerchantSupportTranslationDispatcher(
    "redis://user:secret@example.invalid:6379/0",
    { warn(name: string, fields: Record<string, unknown>) { events.push({ name, fields }); } } as never,
    (() => queue) as never,
  );

  await dispatcher.enqueue("translation-1");
  const failure = Object.assign(new Error("connect ECONNREFUSED redis://user:secret@example.invalid:6379",
    { cause: new Error("retry redis://user:secret@example.invalid:6379?token=super-secret") }), {
    code: "ECONNREFUSED",
  });
  queue.emit("error", failure);
  queue.emit("error", new Error("second connection error"));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.name, "merchant.support.translation_queue.error");
  assert.equal(events[0]?.fields.errorMessage,
    "connect ECONNREFUSED redis://[redacted]");
  assert.equal(events[0]?.fields.errorCode, "ECONNREFUSED");
  assert.equal(events[0]?.fields.errorCause, "retry redis://[redacted]");
  assert.equal(JSON.stringify(events).includes("secret"), false);
  await dispatcher.close();
});
