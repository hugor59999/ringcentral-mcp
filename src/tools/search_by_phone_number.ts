import { z } from "zod";

import { toApiPhoneNumber } from "../ringcentral/call-log.js";
import { callsProvider } from "../timeline/providers/calls.js";
import { smsProvider } from "../timeline/providers/sms.js";
import { voicemailProvider } from "../timeline/providers/voicemail.js";
import type { TimelineEvent, TimelineProvider, TimelineQuery } from "../timeline/types.js";

/**
 * `search_by_phone_number` — one chronological timeline for a phone number.
 *
 * Sources are independent providers that each return TimelineEvent[]. Adding
 * SMS or voicemail later means writing another provider and listing it in
 * PROVIDERS — the merge, sort and response shape do not change.
 */

/**
 * Registered providers. All three are wired in; sms and voicemail report
 * themselves unavailable until the ReadMessages scope is enabled, and start
 * contributing events automatically once it is — no code change needed.
 */
const PROVIDERS: TimelineProvider[] = [callsProvider, smsProvider, voicemailProvider];

/** Page size handed to each provider; the per-source caps still apply. */
const PROVIDER_PAGE_SIZE = 100;

const isoDate = (label: string) =>
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: `${label} must be an ISO 8601 date-time, e.g. 2026-08-01T00:00:00Z`,
  });

export const searchByPhoneNumberInputSchema = {
  phoneNumber: z
    .string()
    .min(3)
    .describe(
      "Phone number to build the timeline for. E.164 (+14155551234) or any " +
        "formatted variant; it is reduced to digits before querying.",
    ),
  dateFrom: isoDate("dateFrom")
    .optional()
    .describe("Only include events at or after this ISO 8601 timestamp"),
  dateTo: isoDate("dateTo")
    .optional()
    .describe("Only include events at or before this ISO 8601 timestamp"),
};

const inputObject = z.object(searchByPhoneNumberInputSchema);
export type SearchByPhoneNumberInput = z.infer<typeof inputObject>;

export interface TimelineSourceReport {
  source: string;
  type: string;
  events: number;
  /** True when this source had more data than the caps allowed. */
  truncated: boolean;
  stats?: Record<string, number>;
  /** Present when this source failed; other sources still returned. */
  error?: string;
  /** Present when the source is not readable yet, e.g. a scope is missing. */
  unavailable?: string;
}

export interface SearchByPhoneNumberResult {
  phoneNumber: string;
  queriedAs: string;
  dateFrom?: string;
  dateTo?: string;
  count: number;
  /** True if any source was truncated. */
  truncated: boolean;
  sources: TimelineSourceReport[];
  /** Derived from the sources that reported themselves unavailable. */
  pendingSources: Array<{ type: string; blockedBy: string }>;
  events: TimelineEvent[];
}

export async function searchByPhoneNumber(
  input: SearchByPhoneNumberInput,
): Promise<SearchByPhoneNumberResult> {
  const { phoneNumber, dateFrom, dateTo } = input;

  const queriedAs = toApiPhoneNumber(phoneNumber);
  if (queriedAs.length < 3) {
    throw new Error(
      `phoneNumber "${phoneNumber}" contains too few digits to search.`,
    );
  }

  const query: TimelineQuery = {
    phoneNumber: queriedAs,
    dateFrom,
    dateTo,
    perPage: PROVIDER_PAGE_SIZE,
  };

  const events: TimelineEvent[] = [];
  const sources: TimelineSourceReport[] = [];

  // Sequential, not parallel: RingCentral rate-limits hard and providers will
  // share that budget as more are added.
  for (const provider of PROVIDERS) {
    try {
      const result = await provider.fetch(query);
      events.push(...result.events);
      sources.push({
        source: provider.name,
        type: provider.type,
        events: result.events.length,
        truncated: result.truncated,
        stats: result.stats,
        unavailable: result.unavailable,
      });
    } catch (error) {
      // One failing source must not discard the others.
      sources.push({
        source: provider.name,
        type: provider.type,
        events: 0,
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // An unavailable source is not a failure — only hard errors count.
  if (sources.length > 0 && sources.every((source) => source.error)) {
    throw new Error(
      `Every timeline source failed. First error: ${sources[0]!.error}`,
    );
  }

  // Oldest first. Events with no timestamp sort last rather than corrupting
  // the ordering of the rest.
  events.sort((a, b) => {
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return Date.parse(a.timestamp) - Date.parse(b.timestamp);
  });

  return {
    phoneNumber,
    queriedAs,
    dateFrom,
    dateTo,
    count: events.length,
    truncated: sources.some((source) => source.truncated),
    sources,
    pendingSources: sources
      .filter((source) => source.unavailable)
      .map((source) => ({ type: source.type, blockedBy: source.unavailable! })),
    events,
  };
}

export const searchByPhoneNumberToolConfig = {
  title: "Search by phone number",
  description:
    "Build one chronological timeline of all contact with a phone number, " +
    "oldest first. Currently covers calls from the RingCentral call log, " +
    "each enriched with duration, outcome, caller name and — where a " +
    "recording exists — a signed playback link. SMS and voicemail providers are " +
    "registered and contribute automatically once the ReadMessages scope is " +
    "enabled; until then they are listed in pendingSources. If dateFrom is " +
    "omitted the API defaults to roughly the last 24 hours.",
  inputSchema: searchByPhoneNumberInputSchema,
};
