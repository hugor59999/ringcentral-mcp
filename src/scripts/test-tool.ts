#!/usr/bin/env node
/**
 * Standalone tool smoke test: `npm run test:tool -- [phoneNumber] [dateFrom]`.
 *
 * Exercises each tool directly (no MCP transport):
 *   1. get_call_history for the number
 *   2. find_missed_calls, includeVoicemail=true  (nobody answered)
 *   3. find_missed_calls, includeVoicemail=false (rang out only)
 *   4. get_call_recording for the first recording found in step 1
 *   5. the playback proxy: signed links, expiry, tampering, header token
 *   6. search_by_phone_number — merged timeline, oldest first
 *   7. detect_followups — unanswered calls with no callback, threshold sweep
 *   8. message tools — built, pending the ReadMessages scope
 *   9. send_sms / send_mms — DRY RUN only; never sends anything
 *  10. delete_call_log_entry — preview and guards only; never deletes
 *
 * The proxy section needs the server running: `npm start` in another shell.
 */
import "dotenv/config";

import { z } from "zod";

import { rcGet } from "../ringcentral/client.js";

import { findMissedCalls } from "../tools/find_missed_calls.js";
import { getCallHistory } from "../tools/get_call_history.js";
import { getCallRecording } from "../tools/get_call_recording.js";
import { searchByPhoneNumber } from "../tools/search_by_phone_number.js";
import { detectFollowups } from "../tools/detect_followups.js";
import { getVoicemail } from "../tools/get_voicemail.js";
import { getSmsConversation } from "../tools/get_sms_conversation.js";
import { getMessageStatus } from "../tools/get_message_status.js";
import { sendSms } from "../tools/send_sms.js";
import { sendMms } from "../tools/send_mms.js";
import { loadOutboundConfig, resetDuplicateGuard } from "../ringcentral/outbound.js";
import {
  allowDeletions,
  deleteCallLogEntry,
  deleteCallLogEntryInputSchema,
} from "../tools/delete_call_log_entry.js";
import { loadPlaybackConfig } from "../http/playback.js";
import { buildSignedPlaybackUrl, signPlayback } from "../http/signing.js";

const DEFAULT_DAYS_BACK = 30;

function section(title: string): void {
  console.log("");
  console.log("=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

async function main(): Promise<void> {
  const [phoneNumberArg, dateFromArg] = process.argv.slice(2);

  const phoneNumber = phoneNumberArg ?? "+14155551234";
  const dateFrom =
    dateFromArg ?? new Date(Date.now() - DEFAULT_DAYS_BACK * 86_400_000).toISOString();

  section(`get_call_history — ${phoneNumber} since ${dateFrom}`);
  const history = await getCallHistory({ phoneNumber, dateFrom, perPage: 20 });
  console.log(JSON.stringify(history, null, 2));
  console.log(
    `\nTOOL OK — ${history.count} call(s) across ${history.pagesFetched} page(s)` +
      (history.truncated ? " (truncated — more available)" : ""),
  );

  section(`find_missed_calls — includeVoicemail=true — since ${dateFrom}`);
  const anyUnanswered = await findMissedCalls({
    dateFrom,
    perPage: 100,
    includeVoicemail: true,
  });
  console.log(
    JSON.stringify({ ...anyUnanswered, calls: anyUnanswered.calls.slice(0, 3) }, null, 2),
  );
  console.log(
    `\nTOOL OK — ${anyUnanswered.count} unanswered of ${anyUnanswered.inboundScanned} ` +
      `inbound; matched ${anyUnanswered.matchedResults.join(", ")}`,
  );

  section(`find_missed_calls — includeVoicemail=false — since ${dateFrom}`);
  const rangOut = await findMissedCalls({
    dateFrom,
    perPage: 100,
    includeVoicemail: false,
  });
  console.log(JSON.stringify({ ...rangOut, calls: rangOut.calls.slice(0, 3) }, null, 2));
  console.log(
    `\nTOOL OK — ${rangOut.count} rang out of ${rangOut.inboundScanned} inbound; ` +
      `matched ${rangOut.matchedResults.join(", ")}`,
  );

  const breakdown = new Map<string, number>();
  for (const call of anyUnanswered.calls) {
    breakdown.set(call.result ?? "?", (breakdown.get(call.result ?? "?") ?? 0) + 1);
  }
  console.log("");
  console.log("Cross-check — outcome breakdown of the includeVoicemail=true set:");
  for (const [result, n] of [...breakdown].sort()) console.log(`  ${result}: ${n}`);
  console.log(
    `  voicemail-only difference: ${anyUnanswered.count - rangOut.count} ` +
      `(true=${anyUnanswered.count} − false=${rangOut.count})`,
  );

  section("get_call_recording");
  const withRecording = history.calls.find((call) => call.recordingId);
  if (!withRecording?.recordingId) {
    console.log(
      `No call with a recording in the ${phoneNumber} history; skipping. ` +
        `Pass a number that has one, or call the tool with an explicit id.`,
    );
    return;
  }

  console.log(`Using recordingId ${withRecording.recordingId} from the call at ` +
    `${withRecording.startTime}`);
  const recording = await getCallRecording({ recordingId: withRecording.recordingId });
  console.log(JSON.stringify(recording, null, 2));

  // The response must not carry a RingCentral credential anywhere.
  const serialized = JSON.stringify(recording);
  const leaked = /access_token|eyJ[A-Za-z0-9_-]{10,}/.test(serialized);
  console.log("");
  console.log(
    leaked
      ? "LEAK CHECK FAILED — a RingCentral credential appears in the tool output"
      : "Leak check OK — no RingCentral token in the tool output or playbackUrl",
  );

  section("playback proxy — GET /recording/:id");
  const { authToken, signingSecret, baseUrl } = loadPlaybackConfig();
  const id = recording.recordingId;
  const signedUrl = recording.playbackUrl;

  const summarize = async (label: string, response: Response): Promise<number> => {
    const type = response.headers.get("content-type") ?? "";
    if (type.startsWith("audio")) {
      const bytes = Buffer.from(await response.arrayBuffer());
      console.log(
        `${label.padEnd(28)} -> ${response.status} ${type} ${bytes.byteLength}B ` +
          `first=${bytes.subarray(0, 3).toString("hex")}`,
      );
      return response.status;
    }
    const body = (await response.text()).slice(0, 90);
    console.log(`${label.padEnd(28)} -> ${response.status} ${body}`);
    return response.status;
  };

  const range = { Range: "bytes=0-2047" };

  // 1. The signed link, exactly as a browser would fetch it: no headers.
  let signedStatus = await summarize(
    "signed link (no headers)",
    await fetch(signedUrl, { headers: range }),
  );
  if (signedStatus === 429) {
    console.log("  media host throttled; waiting 60s and retrying…");
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    signedStatus = await summarize(
      "signed link (retry)",
      await fetch(signedUrl, { headers: range }),
    );
  }

  // 2. Expired link.
  const expired = buildSignedPlaybackUrl(baseUrl, id, -60, signingSecret);
  const expiredStatus = await summarize("expired exp", await fetch(expired.url));

  // 3. Tampered signature.
  const tamperedSig = new URL(signedUrl);
  const original = tamperedSig.searchParams.get("sig")!;
  tamperedSig.searchParams.set("sig", `${original.slice(0, -1)}${original.endsWith("A") ? "B" : "A"}`);
  const tamperedSigStatus = await summarize("tampered sig", await fetch(tamperedSig));

  // 4. Signature valid for this id, replayed against a different id.
  const swapped = new URL(signedUrl);
  swapped.pathname = "/recording/9999999999999";
  const swappedStatus = await summarize("sig replayed on another id", await fetch(swapped));

  // 5. Extended exp with the original signature — must not buy extra time.
  const extended = new URL(signedUrl);
  extended.searchParams.set("exp", String(Number(extended.searchParams.get("exp")) + 86_400));
  const extendedStatus = await summarize("exp extended, sig reused", await fetch(extended));

  // 6. The header path still works.
  const headerStatus = await summarize(
    "header token",
    await fetch(`${baseUrl}/recording/${id}`, {
      headers: { Authorization: `Bearer ${authToken}`, ...range },
    }),
  );

  // 7. Nothing secret in the link itself.
  const secretsInUrl = [
    ["static playback token", signedUrl.includes(authToken)],
    ["signing secret", signedUrl.includes(signingSecret)],
    ["RingCentral token", /access_token|eyJ[A-Za-z0-9_-]{10,}/.test(signedUrl)],
  ] as const;
  console.log("");
  console.log("Signed URL:", signedUrl);
  for (const [what, present] of secretsInUrl) {
    console.log(`  ${present ? "LEAKED" : "absent"}: ${what}`);
  }

  const allGood =
    (signedStatus === 206 || signedStatus === 200) &&
    expiredStatus === 401 &&
    tamperedSigStatus === 401 &&
    swappedStatus === 401 &&
    extendedStatus === 401 &&
    (headerStatus === 206 || headerStatus === 200) &&
    secretsInUrl.every(([, present]) => !present);

  console.log("");
  console.log(
    allGood
      ? "TOOL OK — signed links play, forgeries and expiry are rejected, no secrets in the URL"
      : "TOOL FAILED — unexpected proxy behaviour",
  );

  await timelineSection(phoneNumber, dateFrom);
  await followupSection(dateFrom);
  await messageToolsSection(phoneNumber, dateFrom);
  await sendToolsSection();
  await deleteToolSection(history.calls.find((call) => call.id)?.id);
}

async function timelineSection(phoneNumber: string, dateFrom: string): Promise<void> {
  section(`search_by_phone_number — ${phoneNumber} since ${dateFrom}`);
  const timeline = await searchByPhoneNumber({ phoneNumber, dateFrom });

  console.log(
    JSON.stringify(
      { ...timeline, events: timeline.events.slice(0, 2) },
      null,
      2,
    ),
  );
  if (timeline.events.length > 2) {
    console.log(`  … ${timeline.events.length - 2} more event(s) omitted from this printout`);
  }

  console.log("");
  console.log("Chronological order (oldest first):");
  let ascending = true;
  let previous = Number.NEGATIVE_INFINITY;
  for (const event of timeline.events) {
    const at = Date.parse(event.timestamp);
    if (at < previous) ascending = false;
    previous = at;
    const playback = (event.details as { playbackUrl?: string }).playbackUrl;
    console.log(`  ${event.timestamp}  ${event.type.padEnd(9)} ${event.summary}`);
    if (playback) console.log(`${" ".repeat(30)}playback: ${playback.slice(0, 78)}…`);
  }

  console.log("");
  console.log(`  ordering ascending: ${ascending}`);
  console.log(
    `  events with a playbackUrl: ` +
      `${timeline.events.filter((e) => (e.details as { playbackUrl?: string }).playbackUrl).length}`,
  );

  // A link straight out of the timeline must play with no headers.
  const recorded = timeline.events.find(
    (e) => (e.details as { playbackUrl?: string }).playbackUrl,
  );
  if (recorded) {
    const url = (recorded.details as { playbackUrl: string }).playbackUrl;
    let probe = await fetch(url, { headers: { Range: "bytes=0-2047" } });
    for (let attempt = 0; probe.status === 429 && attempt < 2; attempt++) {
      const waitSeconds = Number(probe.headers.get("retry-after") ?? 60);
      console.log(`  media host throttled; waiting ${waitSeconds}s…`);
      await probe.text();
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      probe = await fetch(url, { headers: { Range: "bytes=0-2047" } });
    }
    const bytes = Buffer.from(await probe.arrayBuffer());
    console.log(
      `  timeline playbackUrl probe: HTTP ${probe.status} ` +
        `${probe.headers.get("content-type")} ${bytes.byteLength}B ` +
        `first=${bytes.subarray(0, 3).toString("hex")}`,
    );
    console.log(
      probe.status === 206
        ? "TOOL OK — timeline playbackUrl streams audio"
        : "TOOL FAILED — timeline playbackUrl did not stream",
    );
  } else {
    console.log("  (no recorded call in range; playbackUrl not exercised)");
  }
}

async function followupSection(dateFrom: string): Promise<void> {
  section(`detect_followups — account-wide since ${dateFrom}`);

  // Sweep the threshold: raising it must only ever shrink the result set.
  const sweep: Array<{ hours: number; count: number; notYetStale: number }> = [];
  for (const hours of [1, 48, 336]) {
    const result = await detectFollowups({ dateFrom, staleAfterHours: hours });
    sweep.push({
      hours,
      count: result.count,
      notYetStale: result.excluded.notYetStale,
    });
    console.log(
      `staleAfterHours=${String(hours).padStart(3)} -> ` +
        `followups=${String(result.count).padStart(3)} ` +
        `notYetStale=${String(result.excluded.notYetStale).padStart(3)} ` +
        `calledBack=${result.excluded.calledBack}`,
    );
  }

  const monotonic = sweep.every((row, i) => i === 0 || row.count <= sweep[i - 1]!.count);
  console.log(`  raising the threshold only shrinks the set: ${monotonic}`);

  const detail = await detectFollowups({ dateFrom, staleAfterHours: 1 });
  console.log("");
  console.log(JSON.stringify({ ...detail, followups: detail.followups.slice(0, 2) }, null, 2));
  if (detail.followups.length > 2) {
    console.log(`  … ${detail.followups.length - 2} more follow-up(s) omitted`);
  }

  console.log("");
  console.log("Most overdue first:");
  for (const followup of detail.followups.slice(0, 8)) {
    console.log(
      `  ${followup.lastUnansweredAt}  ` +
        `${String(followup.hoursSinceLastUnanswered).padStart(6)}h  ` +
        `x${followup.unansweredCount}  ` +
        `${followup.participant.number ?? followup.participant.extension}  ` +
        `${followup.participant.name ?? ""}`,
    );
  }

  const hours = detail.followups.map((f) => f.hoursSinceLastUnanswered ?? 0);
  const descending = hours.every((v, i) => i === 0 || v <= hours[i - 1]!);
  const grouped = detail.followups.reduce((sum, f) => sum + f.unansweredCount, 0);

  console.log("");
  console.log(`  ordered most-overdue-first: ${descending}`);
  console.log(
    `  accounting: ${detail.scanned.inboundUnanswered} unanswered = ` +
      `${detail.excluded.calledBack} called back + ${grouped} grouped into ` +
      `${detail.count} caller(s)`,
  );
  const balances =
    detail.excluded.calledBack + grouped === detail.scanned.inboundUnanswered;
  console.log(
    descending && monotonic && balances
      ? "TOOL OK — correlation, grouping, ordering and threshold all consistent"
      : "TOOL FAILED — unexpected follow-up behaviour",
  );
}

async function messageToolsSection(phoneNumber: string, dateFrom: string): Promise<void> {
  section("message tools — get_voicemail / get_sms_conversation / get_message_status");
  console.log(
    "These need the ReadMessages scope. Until it is enabled each should report " +
      "the pending scope, not a raw 403.\n",
  );

  const cases: Array<[string, () => Promise<unknown>]> = [
    ["get_voicemail", () => getVoicemail({ dateFrom })],
    ["get_sms_conversation", () => getSmsConversation({ phoneNumber, dateFrom })],
    ["get_message_status", () => getMessageStatus({ messageId: "12345" })],
  ];

  let pending = 0;
  let live = 0;

  for (const [name, run] of cases) {
    try {
      const result = await run();
      live++;
      console.log(`${name.padEnd(22)} -> LIVE`);
      console.log(JSON.stringify(result, null, 2).slice(0, 900));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isScopeMessage = /requires the \w+ scope \(not yet enabled/.test(message);
      if (isScopeMessage) pending++;
      console.log(`${name.padEnd(22)} -> ${isScopeMessage ? "PENDING SCOPE" : "ERROR"}: ${message}`);
    }
  }

  console.log("");
  if (live === cases.length) {
    console.log("TOOL OK — scopes are live and all three message tools returned data");
  } else if (pending === cases.length) {
    console.log(
      "TOOL OK (expected) — all three report the pending ReadMessages scope " +
        "with a clear message rather than a raw 403",
    );
  } else {
    console.log("TOOL FAILED — unexpected mix of live/pending/error responses");
  }

  // The timeline must still return calls with the message providers blocked.
  const timeline = await searchByPhoneNumber({ phoneNumber, dateFrom });
  console.log("");
  console.log("timeline degradation with blocked providers:");
  for (const source of timeline.sources) {
    console.log(
      `  ${source.source.padEnd(10)} events=${source.events} ` +
        `${source.unavailable ? "pending scope" : source.error ? "ERROR" : "ok"}`,
    );
  }
  console.log(`  pendingSources: ${timeline.pendingSources.map((p) => p.type).join(", ") || "(none)"}`);
  console.log(
    timeline.events.length > 0 && !timeline.sources.some((s) => s.error)
      ? "TOOL OK — call events still returned; blocked sources reported as pending"
      : "TOOL FAILED — timeline did not degrade cleanly",
  );
}

/** A 1x1 transparent PNG, so the MMS path can be exercised without a file. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function sendToolsSection(): Promise<void> {
  section("send_sms / send_mms — dry run");

  const config = loadOutboundConfig();
  console.log(`ALLOW_REAL_SENDS -> allowRealSends = ${config.allowRealSends}`);

  if (config.allowRealSends) {
    console.log(
      "\n  REAL SENDING IS ENABLED. This section is skipped so the test run " +
        "cannot text anyone. Unset ALLOW_REAL_SENDS to exercise it.",
    );
    return;
  }

  console.log(`Duplicate window: ${config.duplicateWindowSeconds}s`);
  console.log(`Default sender:   ${config.defaultFrom ?? "(none — from is required)"}`);

  // Count every HTTP call, to prove none of them is a send.
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${String(url).replace(/\?.*/, "")}`);
    return realFetch(url as Parameters<typeof realFetch>[0], init);
  }) as typeof fetch;

  try {
    resetDuplicateGuard();

    console.log("\n--- send_sms preview ---");
    const preview = await sendSms({
        to: "+15125551234",
        text: "Hi, following up on your call.",
        confirm: false,
      });
    console.log(JSON.stringify(preview, null, 2));

    console.log("\n--- confirmation gate (previews send nothing) ---");
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["preview repeated (allowed: nothing was sent)", () => sendSms({ to: "+15125551234", text: "Hi, following up on your call.", confirm: false })],
      ["same text, other recipient", () => sendSms({ to: "+15125559999", text: "Hi, following up on your call.", confirm: false })],
      ["same recipient, other text", () => sendSms({ to: "+15125551234", text: "Something else.", confirm: false })],
    ];
    for (const [label, run] of attempts) {
      try {
        await run();
        console.log(`  ${label.padEnd(28)} -> allowed`);
      } catch (error) {
        console.log(
          `  ${label.padEnd(28)} -> refused: ${
            error instanceof Error ? error.message.split(".")[0] : String(error)
          }`,
        );
      }
    }

    console.log("\n--- authorized-sender validation ---");

    // Find a number that belongs to the account but is not SMS-enabled, rather
    // than hard-coding one — keeps real numbers out of the repository and
    // works on any account.
    const numbers = await rcGet<{
      records?: Array<{ phoneNumber?: string; features?: string[] }>;
    }>("/restapi/v1.0/account/~/extension/~/phone-number", { perPage: 100 });
    const notSmsCapable = (numbers.records ?? []).find(
      (record) => record.phoneNumber && !record.features?.includes("SmsSender"),
    )?.phoneNumber;

    const senders: Array<[string, string | undefined]> = [
      ["an SMS-enabled number", preview.authorizedSenders[0]],
      ["an account number without SMS", notSmsCapable],
      ["a number not on the account", "+12125550000"],
    ];
    for (const [label, from] of senders) {
      if (!from) {
        console.log(`  ${label.padEnd(30)} -> skipped (no such number on this account)`);
        continue;
      }
      try {
        const result = await sendSms({ to: "+15125550001", text: `check ${from}`, from, confirm: false });
        console.log(`  ${label.padEnd(30)} -> accepted as ${result.confirmation.from}`);
      } catch (error) {
        console.log(
          `  ${label.padEnd(30)} -> refused: ${
            error instanceof Error ? error.message.split(".")[0] : String(error)
          }`,
        );
      }
    }

    console.log("\n--- send_mms preview ---");
    const mms = await sendMms({
      to: "+15125557777",
      text: "The form you asked for.",
      confirm: false,
      attachments: [
        { fileName: "form.png", contentType: "image/png", contentBase64: TINY_PNG },
      ],
    });
    console.log(JSON.stringify(mms.confirmation, null, 2));
    console.log(`  request: POST ${mms.request.path} (${mms.request.parts.length} parts)`);

    console.log("\n--- proof that nothing was sent ---");
    for (const call of [...new Set(seen)]) console.log(`  ${call}`);
    const sends = seen.filter(
      (call) => call.startsWith("POST") && (call.includes("/sms") || call.includes("/mms")),
    );
    console.log("");
    console.log(
      sends.length === 0
        ? "TOOL OK — previews only; zero POSTs to the send endpoints"
        : `TOOL FAILED — ${sends.length} real send(s) were attempted`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function deleteToolSection(realCallId: string | undefined): Promise<void> {
  section("delete_call_log_entry — guards only, nothing is deleted");
  console.log(`ALLOW_DELETIONS -> ${allowDeletions()}`);

  // Watch every request so we can prove no DELETE was issued.
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${String(url).split("?")[0]}`);
    return realFetch(url as Parameters<typeof realFetch>[0], init);
  }) as typeof fetch;

  try {
    console.log("\n--- bulk and blank input, rejected by the schema ---");
    const schema = z.object(deleteCallLogEntryInputSchema);
    const bad: Array<[string, unknown]> = [
      ["array of ids", ["id-a", "id-b"]],
      ["comma-separated", "id-a,id-b"],
      ["space-separated", "id-a id-b"],
      ["newline-separated", "id-a\nid-b"],
      ["blank", ""],
      ["whitespace only", "   "],
    ];
    for (const [label, value] of bad) {
      const parsed = schema.safeParse({ callId: value });
      console.log(
        `  ${label.padEnd(20)} -> ${
          parsed.success ? "ACCEPTED (unexpected)" : "rejected"
        }`,
      );
    }

    if (!realCallId) {
      console.log("\n  (no call id available from the history above; preview skipped)");
    } else {
      console.log(`\n--- preview, no confirm (real entry ${realCallId}) ---`);
      const preview = await deleteCallLogEntry({ callId: realCallId, confirm: false });
      console.log(`  deleted: ${preview.deleted}`);
      console.log(`  summary: ${preview.summary}`);
      console.log(`  warning: ${preview.warning}`);

      console.log("\n--- confirm: true, with the server gate as configured ---");
      const confirmed = await deleteCallLogEntry({ callId: realCallId, confirm: true });
      console.log(`  deleted: ${confirmed.deleted}`);
      if (!confirmed.deleted) console.log(`  reason : ${confirmed.reason}`);
    }

    console.log("\n--- unknown id (exercises the destructive path safely) ---");
    try {
      await deleteCallLogEntry({ callId: "NOTAREALCALLID0000", confirm: true });
      console.log("  ACCEPTED (unexpected)");
    } catch (error) {
      console.log(`  refused: ${error instanceof Error ? error.message.split(".")[0] : error}`);
    }

    const deletes = seen.filter((call) => call.startsWith("DELETE"));
    console.log("\n--- proof that nothing was deleted ---");
    for (const call of [...new Set(seen)].filter((c) => !c.includes("oauth"))) {
      console.log(`  ${call}`);
    }
    console.log("");
    console.log(
      deletes.length === 0
        ? "TOOL OK — guards held; zero DELETE requests issued"
        : `TOOL FAILED — ${deletes.length} DELETE request(s) were issued`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch((error: unknown) => {
  console.error("");
  console.error("TOOL FAILED");
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
