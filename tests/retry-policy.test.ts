import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { canRetryNativeConnectorFailure, ChatGptWebTurnRetryPolicy, MAX_CHATGPT_WEB_TURN_RETRIES } from "../src/adapters/chatgpt-web/retry-policy";

test("permits exactly five retries per native turn and isolates other turns", () => {
  expect(MAX_CHATGPT_WEB_TURN_RETRIES).toBe(5);
  const policy = new ChatGptWebTurnRetryPolicy();
  const failure = new ChatGptWebAdapterError("connector unavailable", {
    status: 502, errorType: "server_error", code: "native_connector_internal_error", retryable: true,
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect(policy.recordRetryableFailure("a", failure, attempt).retryable).toBe(true);
    expect(policy.exhaustedError("a", attempt)).toBeUndefined();
  }
  expect(policy.recordRetryableFailure("a", failure, 5).retryable).toBe(false);
  expect(policy.exhaustedError("a", 6)?.retryable).toBe(false);
  expect(policy.recordRetryableFailure("b", failure, 6).retryable).toBe(true);
  policy.clear("a");
  expect(policy.exhaustedError("a", 7)).toBeUndefined();
});

test("connector retries require no new dispatch and no unresolved native call", () => {
  const idle = { initialBatchRevision: 4, currentBatchRevision: 4, activeToolCalls: 0, outstandingToolCalls: 0 };
  expect(canRetryNativeConnectorFailure(idle)).toBe(true);
  for (const change of [
    { currentBatchRevision: 5 }, { currentBatchRevision: 3 }, { activeToolCalls: 1 },
    { outstandingToolCalls: 1 }, { initialBatchRevision: -1 }, { activeToolCalls: NaN },
  ]) expect(canRetryNativeConnectorFailure({ ...idle, ...change })).toBe(false);
});
