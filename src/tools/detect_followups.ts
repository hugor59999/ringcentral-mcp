import { z } from "zod";

import { fetchCallLog, toApiPhoneNumber, type NormalizedCall } from "../ringcentral/call-log.js";
import { buildUnansweredMatcher } from "./find_missed_calls.js";

/**
 * `detect_followups` — unanswered inbound calls that never got a callback.
 *
 * This is a correlation, not a listing: an unanswered call is only a pending
 * follow-up if no outbound call went to that number afterwards, and enough
 * time has passed that it counts as overdue.
 *
 * v1 correlates calls only. Inbound SMS with no reply, and voicemail with no
 * callback, need the SMS and ReadMessages scopes.
 */

const PAGE_SIZE = 100;

const isoDate = (label: string) =>
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: `${label} must be an ISO 8601 date-time, e.g. 2026-08-01T00:00:00Z`,
  });

export const detectFollowupsInputSchema = {
  phoneNumber: z
    .string()
    .min(3)
    .optional()
    .describe(
      "Optional number to check. Omit to scan the whole extension for anyone " +
        "awaiting a callback.",
    ),
  dateFrom: isoDate("dateFrom")
    .optional()
    .describe("Only consider calls at or after this ISO 8601 timestamp"),
  dateTo: isoDate("dateTo")
    .optional()
    .describe("Only consider calls at or before this ISO 8601 timestamp"),
  staleAfterHours: z
    .number()
    .min(0)
    .default(48)
    .describe(
      "How long an unanswered call may sit before it counts as overdue " +
        "(default 48). Measured from the most recent unanswered call from " +
        "that number.",
    ),
};

const inputObject = z.object(detectFollowupsInputSchema);
export type DetectFollowupsInput = z.infer<typeof inputObject>;

export interface FollowupCall {
  callId?: string;
  timestamp?: string;
  result?: string;
  durationFormatted?: string;
}

export interface Followup {
  participant: { number?: string; name?: string; extension?: string };
  /** Most recent unanswered call from this number with no callback after it. */
  lastUnansweredAt?: string;
  hoursSinceLastUnanswered?: number;
  /** How many times they reached out without being answered or called back. */
  unansweredCount: number;
  calls: FollowupCall[];
}

export interface DetectFollowupsResult {
  phoneNumber?: string;
  queriedAs?: string;
  dateFrom?: string;
  dateTo?: string;
  staleAfterHours: number;
  scanned: {
    calls: number;
    inboundUnanswered: number;
    outbound: number;
    pagesFetched: number;
    truncated: boolean;
  };
  /** Why unanswered calls did not become follow-ups. */
  excluded: { calledBack: number; notYetStale: number };
  count: number;
  pendingSources: Array<{ type: string; blockedBy: string }>;
  followups: Followup[];
}

const PENDING_SOURCES = [
  { type: "sms", blockedBy: "SMS scope not granted — inbound SMS without a reply is not detected" },
  {
    type: "voicemail",
    blockedBy: "ReadMessages scope not granted — voicemail without a callback is not detected",
  },
];

/** Groups by digits, falling back to an extension for internal calls. */
function participantKey(party: NormalizedCall["from"]): string | undefined {
  if (party.number) {
    const digits = toApiPhoneNumber(party.number);
    if (digits.length >= 3) return digits;
  }
  if (party.extension) return `ext:${party.extension}`;
  return undefined;
}

export async function detectFollowups(
  input: DetectFollowupsInput,
): Promise<DetectFollowupsResult> {
  const { phoneNumber, dateFrom, dateTo, staleAfterHours } = input;

  let queriedAs: string | undefined;
  if (phoneNumber !== undefined) {
    queriedAs = toApiPhoneNumber(phoneNumber);
    if (queriedAs.length < 3) {
      throw new Error(`phoneNumber "${phoneNumber}" contains too few digits to search.`);
    }
  }

  // One pass over the window gets both sides of the correlation.
  const main = await fetchCallLog({
    phoneNumber: queriedAs,
    dateFrom,
    dateTo,
    perPage: PAGE_SIZE,
  });

  const { isMatch } = buildUnansweredMatcher(true);

  const unanswered = main.calls.filter(
    (call) => call.direction === "Inbound" && isMatch(call),
  );
  const outbound: NormalizedCall[] = main.calls.filter(
    (call) => call.direction === "Outbound",
  );

  let pagesFetched = main.pagesFetched;
  let truncated = main.truncated;

  // A callback can land after dateTo. Without this second pass, a window that
  // ends in the past reports people as awaiting a callback they already got.
  const now = Date.now();
  if (dateTo && Date.parse(dateTo) < now) {
    const later = await fetchCallLog({
      phoneNumber: queriedAs,
      dateFrom: dateTo,
      perPage: PAGE_SIZE,
      direction: "Outbound",
    });
    outbound.push(...later.calls);
    pagesFetched += later.pagesFetched;
    truncated = truncated || later.truncated;
  }

  // Outbound attempts per number, so "was there a callback after this call?"
  // is a lookup rather than a scan.
  const outboundByNumber = new Map<string, number[]>();
  for (const call of outbound) {
    const key = participantKey(call.to);
    if (!key || !call.startTime) continue;
    const times = outboundByNumber.get(key) ?? [];
    times.push(Date.parse(call.startTime));
    outboundByNumber.set(key, times);
  }

  let calledBack = 0;
  const pendingByNumber = new Map<string, NormalizedCall[]>();

  for (const call of unanswered) {
    const key = participantKey(call.from);
    if (!key || !call.startTime) continue;

    const at = Date.parse(call.startTime);
    const wasCalledBack = (outboundByNumber.get(key) ?? []).some((time) => time > at);
    if (wasCalledBack) {
      calledBack++;
      continue;
    }

    const pending = pendingByNumber.get(key) ?? [];
    pending.push(call);
    pendingByNumber.set(key, pending);
  }

  const staleCutoffMs = staleAfterHours * 3_600_000;
  const followups: Followup[] = [];
  let notYetStale = 0;

  for (const calls of pendingByNumber.values()) {
    // Newest first, so calls[0] is the most recent unanswered contact.
    const sorted = [...calls].sort(
      (a, b) => Date.parse(b.startTime ?? "") - Date.parse(a.startTime ?? ""),
    );
    const mostRecent = sorted[0]!;
    const at = Date.parse(mostRecent.startTime ?? "");

    // Staleness is measured from the most recent attempt: someone who called
    // an hour ago is not overdue just because they also called last week.
    if (now - at < staleCutoffMs) {
      notYetStale++;
      continue;
    }

    const named = sorted.find((call) => call.from.name);

    followups.push({
      participant: {
        number: mostRecent.from.number,
        name: named?.from.name,
        extension: mostRecent.from.extension,
      },
      lastUnansweredAt: mostRecent.startTime,
      hoursSinceLastUnanswered: Math.round(((now - at) / 3_600_000) * 10) / 10,
      unansweredCount: sorted.length,
      calls: sorted.map((call) => ({
        callId: call.id,
        timestamp: call.startTime,
        result: call.result,
        durationFormatted: call.durationFormatted,
      })),
    });
  }

  // Most overdue first: oldest last-contact at the top.
  followups.sort(
    (a, b) => Date.parse(a.lastUnansweredAt ?? "") - Date.parse(b.lastUnansweredAt ?? ""),
  );

  return {
    phoneNumber,
    queriedAs,
    dateFrom,
    dateTo,
    staleAfterHours,
    scanned: {
      calls: main.calls.length,
      inboundUnanswered: unanswered.length,
      outbound: outbound.length,
      pagesFetched,
      truncated,
    },
    excluded: { calledBack, notYetStale },
    count: followups.length,
    pendingSources: PENDING_SOURCES,
    followups,
  };
}

export const detectFollowupsToolConfig = {
  title: "Detect pending follow-ups",
  description:
    "Find callers who reached out, were not answered, and never got a call " +
    "back. Unlike find_missed_calls this correlates: an unanswered call is " +
    "dropped if any outbound call went to that number afterwards. Results are " +
    "grouped per caller and returned most-overdue first. Calls only for now — " +
    "unanswered SMS and voicemail need the SMS and ReadMessages scopes.",
  inputSchema: detectFollowupsInputSchema,
};
