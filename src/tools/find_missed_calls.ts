import { z } from "zod";

import {
  fetchCallLog,
  toApiPhoneNumber,
  type NormalizedCall,
} from "../ringcentral/call-log.js";

/**
 * `find_missed_calls` — inbound calls that nobody picked up.
 *
 * RingCentral has no server-side `result` filter (passing `result=Missed` is
 * silently ignored and returns every outcome), so direction is filtered by the
 * API and the outcome is filtered here.
 */

/**
 * Outcome vocabulary, compared case/space-insensitively.
 *
 * "No Answer" is grouped with "Missed": RingCentral uses both labels for a call
 * that simply rang out, so excluding it would silently drop unanswered calls.
 * `matchedResults` in the response always spells out which labels were used.
 */
const STRICT_MISSED_RESULTS = ["Missed", "No Answer"];
const VOICEMAIL_RESULT = "Voicemail";

const canonical = (value: string): string => value.toLowerCase().replace(/\s+/g, "");

/**
 * Builds the "nobody answered" predicate. Exported so correlation tools
 * (detect_followups) classify outcomes exactly the same way.
 *
 * Takes anything carrying a `result`, so it works on both raw call-log
 * records and normalized calls.
 */
export function buildUnansweredMatcher(includeVoicemail: boolean): {
  matchedResults: string[];
  isMatch: (record: { result?: string }) => boolean;
} {
  const matchedResults = includeVoicemail
    ? [...STRICT_MISSED_RESULTS, VOICEMAIL_RESULT]
    : [...STRICT_MISSED_RESULTS];

  const allowed = new Set(matchedResults.map(canonical));

  return {
    matchedResults,
    isMatch: (record) =>
      record.result !== undefined && allowed.has(canonical(record.result)),
  };
}

const isoDate = (label: string) =>
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: `${label} must be an ISO 8601 date-time, e.g. 2026-08-01T00:00:00Z`,
  });

export const findMissedCallsInputSchema = {
  phoneNumber: z
    .string()
    .min(3)
    .optional()
    .describe(
      "Optional caller to narrow to. E.164 (+14155551234) or any formatted " +
        "variant; it is reduced to digits before querying. Omit for all missed " +
        "calls on the extension.",
    ),
  dateFrom: isoDate("dateFrom")
    .optional()
    .describe("Only include calls at or after this ISO 8601 timestamp"),
  dateTo: isoDate("dateTo")
    .optional()
    .describe("Only include calls at or before this ISO 8601 timestamp"),
  includeVoicemail: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), count any call nobody answered — 'Missed', " +
        "'No Answer' and 'Voicemail'. When false, exclude calls that reached " +
        "voicemail and return only calls that rang out.",
    ),
  perPage: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Records per API page (default 20); pagination is followed automatically"),
};

const inputObject = z.object(findMissedCallsInputSchema);
export type FindMissedCallsInput = z.infer<typeof inputObject>;

export interface MissedCallsResult {
  phoneNumber?: string;
  /** Digits-only form actually sent to the API, when a number was given. */
  queriedAs?: string;
  dateFrom?: string;
  dateTo?: string;
  count: number;
  includeVoicemail: boolean;
  /** Inbound records examined before the outcome filter. */
  inboundScanned: number;
  pagesFetched: number;
  truncated: boolean;
  /** The result values treated as "missed". */
  matchedResults: string[];
  calls: NormalizedCall[];
}

export async function findMissedCalls(input: FindMissedCallsInput): Promise<MissedCallsResult> {
  const { phoneNumber, dateFrom, dateTo, perPage, includeVoicemail } = input;

  const { matchedResults, isMatch } = buildUnansweredMatcher(includeVoicemail);

  let queriedAs: string | undefined;
  if (phoneNumber !== undefined) {
    queriedAs = toApiPhoneNumber(phoneNumber);
    if (queriedAs.length < 3) {
      throw new Error(
        `phoneNumber "${phoneNumber}" contains too few digits to search the call log.`,
      );
    }
  }

  const { calls, pagesFetched, recordsScanned, truncated } = await fetchCallLog({
    phoneNumber: queriedAs,
    dateFrom,
    dateTo,
    perPage,
    direction: "Inbound",
    filter: isMatch,
  });

  return {
    phoneNumber,
    queriedAs,
    dateFrom,
    dateTo,
    count: calls.length,
    includeVoicemail,
    inboundScanned: recordsScanned,
    pagesFetched,
    truncated,
    matchedResults,
    calls,
  };
}

export const findMissedCallsToolConfig = {
  title: "Find missed calls",
  description:
    "List inbound RingCentral calls that nobody answered. By default this " +
    "includes calls that rang out ('Missed', 'No Answer') and calls that " +
    "reached voicemail ('Voicemail'); set includeVoicemail=false to exclude " +
    "voicemail. Optionally narrowed to one caller and/or a date range. If " +
    "dateFrom is omitted the API defaults to roughly the last 24 hours. The " +
    "response echoes matchedResults so the boundary is explicit.",
  inputSchema: findMissedCallsInputSchema,
};
