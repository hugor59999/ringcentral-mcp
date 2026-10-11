import { rcGet, RingCentralApiError } from "./client.js";

/**
 * Shared message-store layer, mirroring call-log.ts.
 *
 * Handles /restapi/v1.0/account/~/extension/~/message-store: digit
 * normalization, `nextPage` pagination and the rate-limit backoff inherited
 * from client.ts.
 *
 * NOTE: the app does not yet hold the ReadMessages / SMS scopes, so every call
 * here currently returns 403 InsufficientPermissions. The code is written and
 * registered so it works the moment the scopes are enabled, but it has not
 * been exercised against real data — see README.md.
 */

export const MESSAGE_STORE_PATH = "/restapi/v1.0/account/~/extension/~/message-store";

/** Same caps as the call log, for the same reason. */
export const MAX_PAGES = 10;
export const MAX_RECORDS = 250;

export type MessageType = "SMS" | "VoiceMail" | "Fax" | "Pager";

/**
 * RingCentral's delivery states. `Received` is the inbound terminal state; the
 * rest describe an outbound message's progress.
 */
export type MessageStatus =
  | "Queued"
  | "Sent"
  | "Delivered"
  | "DeliveryFailed"
  | "SendingFailed"
  | "Received";

export interface MessageParty {
  phoneNumber?: string;
  extensionNumber?: string;
  name?: string;
  location?: string;
}

export interface MessageAttachment {
  id?: string;
  uri?: string;
  type?: string;
  contentType?: string;
  vmDuration?: number;
  fileName?: string;
}

export interface MessageRecord {
  id?: number | string;
  type?: string;
  direction?: string;
  messageStatus?: string;
  readStatus?: string;
  creationTime?: string;
  lastModifiedTime?: string;
  subject?: string;
  conversationId?: number | string;
  from?: MessageParty;
  to?: MessageParty[];
  attachments?: MessageAttachment[];
  vmTranscriptionStatus?: string;
}

interface MessageStoreResponse {
  records?: MessageRecord[];
  paging?: { page?: number; perPage?: number };
  navigation?: { nextPage?: { uri?: string } };
}

/**
 * The message-store `phoneNumber` filter takes digits, exactly as the call log
 * does. Kept as its own function so the two layers stay independent.
 */
export function toApiPhoneNumber(input: string): string {
  return input.replace(/\D/g, "");
}

/**
 * True for RingCentral's "your app lacks a permission" response.
 * Shape confirmed against the live API: HTTP 403, errorCode
 * `InsufficientPermissions`, message naming the permission in brackets.
 */
export function isPermissionError(error: unknown): error is RingCentralApiError {
  return (
    error instanceof RingCentralApiError &&
    (error.status === 403 || error.errorCode === "InsufficientPermissions")
  );
}

/**
 * Pulls the required permission out of the error message, e.g. "ReadMessages".
 *
 * RingCentral phrases it as "application needs to have [ReadMessages]
 * permission". Match that phrase specifically — the message also contains the
 * errorCode in brackets, which a looser pattern picks up instead.
 */
export function missingScopeFrom(error: RingCentralApiError, fallback: string): string {
  const named = /needs to have \[([^\]]+)\]/i.exec(error.message);
  if (named?.[1]) return named[1].trim();

  // Fall back to the last bracketed group, skipping the leading errorCode.
  const groups = [...error.message.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!.trim());
  const candidate = groups.filter((g) => g !== error.errorCode).pop();
  return candidate || fallback;
}

/**
 * Converts a permission failure into a message that says what to do, instead
 * of surfacing a raw 403.
 */
export function describeScopeError(error: unknown, fallbackScope: string): string | undefined {
  if (!isPermissionError(error)) return undefined;
  const scope = missingScopeFrom(error, fallbackScope);
  return (
    `This requires the ${scope} scope (not yet enabled on the RingCentral app). ` +
    `Enable it in the Developer Console, then re-issue the JWT if needed.`
  );
}

/** Rethrows a permission failure as a clear message; passes anything else through. */
export function rethrowWithScopeHint(error: unknown, fallbackScope: string): never {
  const hint = describeScopeError(error, fallbackScope);
  if (hint) throw new Error(hint);
  throw error;
}

export interface NormalizedMessage {
  id?: string;
  type?: string;
  direction?: string;
  status?: string;
  readStatus?: string;
  timestamp?: string;
  subject?: string;
  conversationId?: string;
  from: { number?: string; name?: string; extension?: string };
  to: Array<{ number?: string; name?: string; extension?: string }>;
  attachments: MessageAttachment[];
  /** Duration of the voicemail audio, when this is a voicemail. */
  durationSeconds?: number;
  transcriptionStatus?: string;
}

function normalizeParty(party: MessageParty | undefined): NormalizedMessage["from"] {
  return {
    number: party?.phoneNumber,
    name: party?.name,
    extension: party?.extensionNumber,
  };
}

export function normalizeMessage(record: MessageRecord): NormalizedMessage {
  const attachments = record.attachments ?? [];
  const audio = attachments.find((a) => a.type === "AudioRecording");

  return {
    id: record.id === undefined ? undefined : String(record.id),
    type: record.type,
    direction: record.direction,
    status: record.messageStatus,
    readStatus: record.readStatus,
    timestamp: record.creationTime,
    subject: record.subject,
    conversationId:
      record.conversationId === undefined ? undefined : String(record.conversationId),
    from: normalizeParty(record.from),
    to: (record.to ?? []).map(normalizeParty),
    attachments,
    durationSeconds: audio?.vmDuration,
    transcriptionStatus: record.vmTranscriptionStatus,
  };
}

export interface FetchMessagesOptions {
  messageType?: MessageType;
  /** Digits-only, or undefined for every conversation. */
  phoneNumber?: string;
  direction?: "Inbound" | "Outbound";
  dateFrom?: string;
  dateTo?: string;
  perPage: number;
  conversationId?: string;
}

export interface FetchMessagesResult {
  messages: NormalizedMessage[];
  pagesFetched: number;
  truncated: boolean;
}

/** Fetches message-store records, following `nextPage` pagination. */
export async function fetchMessages(
  options: FetchMessagesOptions,
): Promise<FetchMessagesResult> {
  const { messageType, phoneNumber, direction, dateFrom, dateTo, perPage, conversationId } =
    options;

  const messages: NormalizedMessage[] = [];
  let pagesFetched = 0;
  let truncated = false;
  let page = 1;

  while (page <= MAX_PAGES) {
    const response = await rcGet<MessageStoreResponse>(MESSAGE_STORE_PATH, {
      messageType,
      phoneNumber,
      direction,
      dateFrom,
      dateTo,
      conversationId,
      perPage,
      page,
    });
    pagesFetched++;

    const records = response.records ?? [];
    for (const record of records) {
      if (messages.length >= MAX_RECORDS) {
        truncated = true;
        break;
      }
      messages.push(normalizeMessage(record));
    }

    const hasNextPage = Boolean(response.navigation?.nextPage?.uri);
    if (truncated || records.length === 0 || !hasNextPage) break;

    if (page === MAX_PAGES) {
      truncated = true;
      break;
    }
    page++;
  }

  return { messages, pagesFetched, truncated };
}

/** Fetches one message by id. */
export async function fetchMessage(messageId: string): Promise<NormalizedMessage> {
  const record = await rcGet<MessageRecord>(`${MESSAGE_STORE_PATH}/${messageId}`);
  return normalizeMessage(record);
}
