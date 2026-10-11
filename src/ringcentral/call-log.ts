import { rcGet } from "./client.js";

/**
 * Shared call-log fetching and normalization.
 *
 * Two RingCentral behaviours are handled here once, so every call-log tool
 * inherits them:
 *
 *  - The `phoneNumber` filter matches digits only. A leading "+" yields zero
 *    records with a 200 response rather than an error.
 *  - The endpoint returns no `totalPages`/`totalElements`; paging is driven
 *    off `navigation.nextPage`.
 */

export const CALL_LOG_PATH = "/restapi/v1.0/account/~/extension/~/call-log";

/** Safety rails so a wide date range can't pull an unbounded result set. */
export const MAX_PAGES = 10;
export const MAX_RECORDS = 250;

interface CallLogParty {
  phoneNumber?: string;
  extensionNumber?: string;
  name?: string;
}

export interface CallLogRecord {
  id?: string;
  sessionId?: string;
  startTime?: string;
  duration?: number;
  type?: string;
  direction?: string;
  action?: string;
  result?: string;
  from?: CallLogParty;
  to?: CallLogParty;
  recording?: { id?: string; contentUri?: string };
}

interface CallLogResponse {
  records?: CallLogRecord[];
  paging?: { page?: number; perPage?: number; pageStart?: number; pageEnd?: number };
  navigation?: { nextPage?: { uri?: string } };
}

export interface NormalizedCall {
  id?: string;
  direction?: string;
  from: { number?: string; name?: string; extension?: string };
  to: { number?: string; name?: string; extension?: string };
  startTime?: string;
  durationSeconds?: number;
  durationFormatted?: string;
  result?: string;
  type?: string;
  action?: string;
  hasRecording: boolean;
  recordingId?: string;
}

/**
 * The call-log `phoneNumber` filter matches on digits only — passing a leading
 * "+" makes it return zero records instead of erroring. Strip to digits so
 * callers can pass E.164 (+14155551234) or any formatted variant.
 */
export function toApiPhoneNumber(input: string): string {
  return input.replace(/\D/g, "");
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

function normalizeParty(party: CallLogParty | undefined): NormalizedCall["from"] {
  return {
    number: party?.phoneNumber,
    name: party?.name,
    extension: party?.extensionNumber,
  };
}

export function normalizeRecord(record: CallLogRecord): NormalizedCall {
  return {
    id: record.id,
    direction: record.direction,
    from: normalizeParty(record.from),
    to: normalizeParty(record.to),
    startTime: record.startTime,
    durationSeconds: record.duration,
    durationFormatted: formatDuration(record.duration),
    result: record.result,
    type: record.type,
    action: record.action,
    hasRecording: Boolean(record.recording?.id),
    recordingId: record.recording?.id,
  };
}

export interface FetchCallLogOptions {
  /** Digits-only number, or undefined for the whole extension. */
  phoneNumber?: string;
  dateFrom?: string;
  dateTo?: string;
  perPage: number;
  /** Server-side direction filter — "Inbound" / "Outbound". */
  direction?: string;
  /**
   * Client-side predicate. RingCentral has no server-side `result` filter
   * (passing one is silently ignored), so outcome filtering happens here.
   */
  filter?: (record: CallLogRecord) => boolean;
}

export interface FetchCallLogResult {
  calls: NormalizedCall[];
  pagesFetched: number;
  /** Records returned by the API before the client-side filter was applied. */
  recordsScanned: number;
  /** True when more records exist but were cut off by MAX_PAGES / MAX_RECORDS. */
  truncated: boolean;
}

/** Fetches call-log records, following pagination and applying any filter. */
export async function fetchCallLog(options: FetchCallLogOptions): Promise<FetchCallLogResult> {
  const { phoneNumber, dateFrom, dateTo, perPage, direction, filter } = options;

  const calls: NormalizedCall[] = [];
  let recordsScanned = 0;
  let pagesFetched = 0;
  let truncated = false;
  let page = 1;

  while (page <= MAX_PAGES) {
    const response = await rcGet<CallLogResponse>(CALL_LOG_PATH, {
      phoneNumber,
      dateFrom,
      dateTo,
      perPage,
      page,
      direction,
      view: "Detailed",
    });
    pagesFetched++;

    const records = response.records ?? [];
    recordsScanned += records.length;

    for (const record of records) {
      if (filter && !filter(record)) continue;
      if (calls.length >= MAX_RECORDS) {
        truncated = true;
        break;
      }
      calls.push(normalizeRecord(record));
    }

    const hasNextPage = Boolean(response.navigation?.nextPage?.uri);

    if (truncated || records.length === 0 || !hasNextPage) break;

    if (page === MAX_PAGES) {
      truncated = true;
      break;
    }
    page++;
  }

  return { calls, pagesFetched, recordsScanned, truncated };
}
