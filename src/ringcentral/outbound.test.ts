import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { clearTokenCache } from "./auth.js";
import { resetThrottle, setMaxRequestsPerMinute } from "./client.js";
import {
  DEFAULT_DUPLICATE_WINDOW_SECONDS,
  clearSenderCache,
  duplicateKey,
  loadOutboundConfig,
  resetDuplicateGuard,
} from "./outbound.js";
import { sendSms } from "../tools/send_sms.js";

/**
 * Covers the duplicate-send guard.
 *
 * On 2026-09-21 the same text went to the same number twice, 162 seconds
 * apart. The guard worked exactly as configured — the window was 60 seconds —
 * which is shorter than how an assistant actually retries.
 */

const SENDER = "+15125550100";
const RECIPIENT = "+13465550199";

let realFetch: typeof globalThis.fetch;

/** Records every POST to the SMS endpoint, so "nothing was sent" is provable. */
let sentMessages: number;

function stubRingCentral(): void {
  sentMessages = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes("/restapi/oauth/token")) {
      return new Response(
        JSON.stringify({ access_token: "t", token_type: "bearer", expires_in: 3600 }),
        { status: 200 },
      );
    }
    if (url.includes("/phone-number")) {
      return new Response(
        JSON.stringify({
          records: [{ phoneNumber: SENDER, features: ["SmsSender", "MmsSender"] }],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/sms")) {
      sentMessages++;
      return new Response(
        JSON.stringify({
          id: 1000 + sentMessages,
          messageStatus: "Queued",
          creationTime: "2026-09-21T20:00:00.000Z",
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected call to ${url}`);
  }) as typeof fetch;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  stubRingCentral();
  clearTokenCache();
  clearSenderCache();
  resetDuplicateGuard();
  resetThrottle();
  setMaxRequestsPerMinute(0);
  process.env.RINGCENTRAL_SERVER_URL = "https://platform.example.test";
  process.env.RINGCENTRAL_CLIENT_ID = "id";
  process.env.RINGCENTRAL_CLIENT_SECRET = "secret";
  process.env.RINGCENTRAL_JWT = "jwt";
  process.env.DEFAULT_SMS_FROM = SENDER;
  delete process.env.DUPLICATE_SEND_WINDOW_SECONDS;
  process.env.ALLOW_REAL_SENDS = "false"; // previews only: nothing leaves the server
  mock.method(console, "error", () => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetDuplicateGuard();
  clearSenderCache();
  setMaxRequestsPerMinute(8);
  mock.restoreAll();
});

describe("duplicate-send window", () => {
  it("defaults to 600 seconds in the code, not only in the environment", () => {
    assert.equal(DEFAULT_DUPLICATE_WINDOW_SECONDS, 600);
    assert.equal(loadOutboundConfig().duplicateWindowSeconds, 600);
  });

  it("still covers the 162-second gap that slipped through in production", () => {
    assert.ok(
      DEFAULT_DUPLICATE_WINDOW_SECONDS > 162,
      "the real duplicate was 2m42s apart and must now be caught",
    );
  });

  it("is still overridable from the environment", () => {
    process.env.DUPLICATE_SEND_WINDOW_SECONDS = "30";
    assert.equal(loadOutboundConfig().duplicateWindowSeconds, 30);
  });
});

describe("duplicate-detection key", () => {
  it("ignores capitalisation", () => {
    assert.equal(
      duplicateKey("sms", [RECIPIENT], "Test From The Connector"),
      duplicateKey("sms", [RECIPIENT], "test from the connector"),
    );
  });

  it("ignores surrounding and repeated whitespace", () => {
    assert.equal(
      duplicateKey("sms", [RECIPIENT], "  hello   there "),
      duplicateKey("sms", [RECIPIENT], "hello there"),
    );
  });

  it("still separates genuinely different messages and recipients", () => {
    assert.notEqual(
      duplicateKey("sms", [RECIPIENT], "hello"),
      duplicateKey("sms", [RECIPIENT], "hello!"),
    );
    assert.notEqual(
      duplicateKey("sms", [RECIPIENT], "hello"),
      duplicateKey("sms", ["+13465550100"], "hello"),
    );
  });
});

describe("what the model is told when a duplicate is refused", () => {
  beforeEach(() => {
    process.env.ALLOW_REAL_SENDS = "true";
  });

  it("refuses the same text and explains that nothing was re-sent", async () => {
    const first = await sendSms({ to: RECIPIENT, text: "Test from the connector", confirm: true });
    assert.equal(first.dryRun, false);
    assert.equal(sentMessages, 1);

    await assert.rejects(
      // Different capitalisation: the same message as far as the recipient goes.
      () => sendSms({ to: RECIPIENT, text: "TEST FROM THE CONNECTOR", confirm: true }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Identical text already sent/);
        assert.match(message, new RegExp(RECIPIENT.replace("+", "\\+")));
        assert.match(message, /not re-sent/);
        assert.match(message, /do not retry/);
        assert.match(message, /600-second window/);
        return true;
      },
    );
    assert.equal(sentMessages, 1, "the duplicate must not reach RingCentral");
  });

  it("lets a genuinely different message through", async () => {
    await sendSms({ to: RECIPIENT, text: "First message", confirm: true });
    const second = await sendSms({
      to: RECIPIENT,
      text: "Second, different message",
      confirm: true,
    });
    assert.equal(second.dryRun, false);
    assert.equal(sentMessages, 2);
  });
});

describe("confirmation gate", () => {
  beforeEach(() => {
    process.env.ALLOW_REAL_SENDS = "true";
  });

  it("sends nothing without confirm and asks for the user's approval", async () => {
    const preview = await sendSms({ to: RECIPIENT, text: "Booking reminder" });

    assert.equal(sentMessages, 0, "nothing may reach RingCentral on a preview");
    assert.equal(preview.dryRun, true);
    assert.equal(preview.awaitingConfirmation, true);
    assert.match(preview.instruction ?? "", /Show this preview to the user/);
    assert.match(preview.instruction ?? "", /confirm: true/);

    // The preview has to carry everything the user needs to judge it.
    assert.equal(preview.confirmation.to, RECIPIENT);
    assert.equal(preview.confirmation.from, SENDER);
    assert.equal(preview.confirmation.text, "Booking reminder");
    assert.equal(preview.confirmation.textLength, "Booking reminder".length);
  });

  it("defaults to not sending when confirm is omitted entirely", async () => {
    const preview = await sendSms({ to: RECIPIENT, text: "No confirm field at all" });
    assert.equal(preview.awaitingConfirmation, true);
    assert.equal(sentMessages, 0);
  });

  it("sends once confirm: true arrives with the same arguments", async () => {
    await sendSms({ to: RECIPIENT, text: "Booking reminder" });
    const sent = await sendSms({ to: RECIPIENT, text: "Booking reminder", confirm: true });

    assert.equal(sent.dryRun, false);
    assert.equal(sent.awaitingConfirmation, false);
    assert.equal(sent.messageId, "1001");
    assert.equal(sentMessages, 1);
  });

  it("does not let a preview trip the duplicate guard on the confirmed call", async () => {
    // Previewing twice, then confirming, must still send: previews are not
    // recorded, otherwise the guard would block the send it exists to permit.
    await sendSms({ to: RECIPIENT, text: "Preview me twice" });
    await sendSms({ to: RECIPIENT, text: "Preview me twice" });
    const sent = await sendSms({ to: RECIPIENT, text: "Preview me twice", confirm: true });

    assert.equal(sent.dryRun, false, "the confirmed send must go through");
    assert.equal(sentMessages, 1);
  });

  it("still refuses to send when the server has sending disabled", async () => {
    process.env.ALLOW_REAL_SENDS = "false";
    const result = await sendSms({ to: RECIPIENT, text: "Nope", confirm: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.awaitingConfirmation, false, "confirming cannot override the server switch");
    assert.match(result.reason ?? "", /ALLOW_REAL_SENDS is not enabled/);
    assert.equal(sentMessages, 0);
  });

  it("validates the sender before previewing, so the preview is truthful", async () => {
    await assert.rejects(
      () => sendSms({ to: RECIPIENT, text: "x", from: "+19998887777" }),
      /not authorized to send with SmsSender/,
      "an unusable sender must fail at preview time, not at send time",
    );
  });
});
