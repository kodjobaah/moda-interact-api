import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { decodeStrictJsonBody, readBoundedBody } from "../../../src/http/body.js";

class TestBodyError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
  }
}

const failure = (reason: "invalid" | "oversized") => reason === "oversized"
  ? new TestBodyError(413, "request_too_large")
  : new TestBodyError(400, "invalid_request");

function incoming(stream: PassThrough): IncomingMessage {
  return stream as unknown as IncomingMessage;
}

function listenersClean(stream: PassThrough): void {
  assert.equal(stream.listenerCount("data"), 0);
  assert.equal(stream.listenerCount("end"), 0);
  assert.equal(stream.listenerCount("aborted"), 0);
  assert.equal(stream.listenerCount("error"), 0);
}

test("readBoundedBody accepts an exact-size streamed body and releases all listeners", async () => {
  const stream = new PassThrough();
  const promise = readBoundedBody(incoming(stream), 4, failure);
  stream.write(Buffer.from("12"));
  stream.end(Buffer.from("34"));
  assert.equal((await promise).toString(), "1234");
  listenersClean(stream);
});

test("readBoundedBody rejects an over-limit streaming body with the caller's 413 error", async () => {
  const stream = new PassThrough();
  const promise = readBoundedBody(incoming(stream), 4, failure);
  stream.end(Buffer.from("12345"));
  await assert.rejects(promise, (error: unknown) => error instanceof TestBodyError &&
    error.statusCode === 413 && error.code === "request_too_large");
  listenersClean(stream);
});

test("readBoundedBody rejects a truncated stream abort with the caller's 400 error", async () => {
  const stream = new PassThrough();
  const promise = readBoundedBody(incoming(stream), 20, failure);
  stream.write(Buffer.from("part"));
  stream.emit("aborted");
  await assert.rejects(promise, (error: unknown) => error instanceof TestBodyError &&
    error.statusCode === 400 && error.code === "invalid_request");
  listenersClean(stream);
  stream.destroy();
});

test("readBoundedBody maps stream errors to the caller's safe error without the original message", async () => {
  const stream = new PassThrough();
  const promise = readBoundedBody(incoming(stream), 20, failure);
  stream.emit("error", new Error("private transport detail"));
  await assert.rejects(promise, (error: unknown) => error instanceof TestBodyError &&
    error.statusCode === 400 && error.code === "invalid_request" && !error.message.includes("private"));
  listenersClean(stream);
  stream.destroy();
});

test("decodeStrictJsonBody rejects malformed UTF-8, NUL and malformed JSON", () => {
  assert.deepEqual(decodeStrictJsonBody(Buffer.from('{"a":1}')), { a: 1 });
  assert.throws(() => decodeStrictJsonBody(Buffer.from([0xc3, 0x28])), TypeError);
  assert.throws(() => decodeStrictJsonBody(Buffer.from('{"a":"x' + "\0" + 'y"}')), Error);
  assert.throws(() => decodeStrictJsonBody(Buffer.from("{")), SyntaxError);
});
