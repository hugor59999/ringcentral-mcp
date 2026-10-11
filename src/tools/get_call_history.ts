import { z } from "zod";

import { fetchCallLog, toApiPhoneNumber, type NormalizedCall } from "../ringcentral/call-log.js";

/**
 * `get_call_history` — call log lookup for a single phone number.
 */

const isoDate = (label: string) =>
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: `${label} must be an ISO 8601 date-time, e.g. 2026-08-01T00:00:00Z`,
  });

export const getCallHistoryInputSchema = {
  phoneNumber: z
    .string()
    .min(3)
    .describe(
      "Phone number to filter the call log by. E.164 (+14155551234) or any " +
        "formatted variant; it is reduced to digits before querying.",
    ),
  dateFrom: isoDate("dateFrom")
    .optional()
    .describe("Only include calls at or after this ISO 8601 timestamp"),
  dateTo: isoDate("dateTo")
    .optional()
    .describe("Only include calls at or before this ISO 8601 timestamp"),
  perPage: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Records per API page (default 20); pagination is followed automatically"),
};

const inputObject = z.object(getCallHistoryInputSchema);
export type GetCallHistoryInput = z.infer<typeof inputObject>;

export interface CallHistoryResult {
  phoneNumber: string;
  /** Digits-only form actually sent to the API. */
  queriedAs: string;
  dateFrom?: string;
  dateTo?: string;
  count: number;
  pagesFetched: number;
  truncated: boolean;
  calls: NormalizedCall[];
}

export async function getCallHistory(input: GetCallHistoryInput): Promise<CallHistoryResult> {
  const { phoneNumber, dateFrom, dateTo, perPage } = input;

  const queriedAs = toApiPhoneNumber(phoneNumber);
  if (queriedAs.length < 3) {
    throw new Error(
      `phoneNumber "${phoneNumber}" contains too few digits to search the call log.`,
    );
  }

  const { calls, pagesFetched, truncated } = await fetchCallLog({
    phoneNumber: queriedAs,
    dateFrom,
    dateTo,
    perPage,
  });

  return {
    phoneNumber,
    queriedAs,
    dateFrom,
    dateTo,
    count: calls.length,
    pagesFetched,
    truncated,
    calls,
  };
}

export const getCallHistoryToolConfig = {
  title: "Get call history",
  description:
    "Look up RingCentral call log entries involving a specific phone number. " +
    "Returns direction, both parties, start time, duration, outcome, and whether " +
    "a call recording exists. If dateFrom is omitted the RingCentral API " +
    "defaults to roughly the last 24 hours.",
  inputSchema: getCallHistoryInputSchema,
};
