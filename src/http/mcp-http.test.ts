import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeRpc } from "./mcp-http.js";

/**
 * Covers what the request log is allowed to say.
 *
 * The value of this log is that it records what the server was asked to do;
 * its danger is that the same payload carries customer phone numbers and the
 * text of messages. The extractor is deliberately narrow, and the last suite
 * here is the one that matters: nothing from `arguments` may ever come out.
 */

describe("describeRpc", () => {
  it("reads the method of a plain request", () => {
    assert.deepEqual(describeRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {
      method: "tools/list",
    });
    assert.deepEqual(describeRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }), {
      method: "initialize",
    });
  });

  it("names the tool on a tools/call", () => {
    const described = describeRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_call_history", arguments: { phoneNumber: "+15125550123" } },
    });
    assert.equal(described.method, "tools/call");
    assert.equal(described.tool, "get_call_history");
  });

  it("summarises a batch without listing it endlessly", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ method: `m${i}` }));
    const described = describeRpc(many);
    assert.match(described.method ?? "", /^batch\[m0,m1,m2,m3,m4,…\]$/);
    assert.equal(described.tool, undefined);
  });

  it("handles a body it cannot read without throwing", () => {
    for (const body of [undefined, null, "", 42, [], {}, { method: 7 }, { params: {} }]) {
      assert.doesNotThrow(() => describeRpc(body));
      assert.equal(describeRpc(body).method, undefined);
    }
  });

  it("does not invent a tool name when params are malformed", () => {
    assert.equal(describeRpc({ method: "tools/call" }).tool, undefined);
    assert.equal(describeRpc({ method: "tools/call", params: null }).tool, undefined);
    assert.equal(describeRpc({ method: "tools/call", params: { name: 42 } }).tool, undefined);
  });
});

describe("what must never reach the log", () => {
  const SENSITIVE = {
    phoneNumber: "+15125550123",
    to: "+13465550199",
    from: "+18595550100",
    text: "Your booking is confirmed for Tuesday",
    recordingId: "1234567890123",
    confirm: true,
  };

  const bodies: Array<[string, unknown]> = [
    [
      "send_sms",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_sms", arguments: SENSITIVE } },
    ],
    [
      "get_call_history",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_call_history", arguments: SENSITIVE },
      },
    ],
    [
      "delete_call_log_entry",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "delete_call_log_entry", arguments: { callId: "VIh5bQSnyHPoDUA", confirm: true } },
      },
    ],
  ];

  for (const [label, body] of bodies) {
    it(`leaks nothing from the arguments of ${label}`, () => {
      const described = describeRpc(body);
      const serialised = JSON.stringify(described);

      for (const value of [
        SENSITIVE.phoneNumber,
        SENSITIVE.to,
        SENSITIVE.from,
        SENSITIVE.text,
        SENSITIVE.recordingId,
        "VIh5bQSnyHPoDUA",
      ]) {
        assert.ok(
          !serialised.includes(value),
          `${value} must not appear in the logged description`,
        );
      }

      // Only these two keys are ever produced.
      assert.deepEqual(Object.keys(described).sort(), ["method", "tool"]);
    });
  }

  it("never carries an authorization header or token", () => {
    const described = describeRpc({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "send_sms", _meta: { authorization: "Bearer super-secret-token" } },
    });
    assert.ok(!JSON.stringify(described).includes("super-secret-token"));
  });
});
