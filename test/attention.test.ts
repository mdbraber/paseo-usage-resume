import assert from "node:assert/strict";
import { test } from "node:test";
import { clearAttention } from "../server/attention.ts";

test("sends a clear_agent_attention request without a requestId", () => {
  const sent: unknown[] = [];
  assert.equal(clearAttention("agent-1", (message) => sent.push(message)), true);
  assert.deepEqual(sent, [
    {
      type: "paseo_frame",
      data: '{"type":"session","message":{"type":"clear_agent_attention","agentId":"agent-1"}}',
      isBinary: false,
    },
  ]);
});

test("reports failure when there is no daemon connection", () => {
  assert.equal(clearAttention("agent-1", undefined), false);
});
