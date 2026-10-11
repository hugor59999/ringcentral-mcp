import { z } from "zod";

import {
  fetchMessages,
  rethrowWithScopeHint,
  toApiPhoneNumber,
} from "../ringcentral/messages.js";

/**
 * `get_sms_conversation` — the SMS thread with one number, chronological.
 *
 * Pending the ReadMessages scope (sending would additionally need SMS).
 */

const PAGE_SIZE = 100;

const isoDate = (label: string) =>
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: `${label} must be an ISO 8601 date-time, e.g. 2026-08-01T00:00:00Z`,
  });

export const getSmsConversationInputSchema = {
  phoneNumber: z
    .string()
    .min(3)
    .describe(
      "The other party's number. E.164 (+14155551234) or any formatted " +
        "variant; it is reduced to digits before querying.",
    ),
  dateFrom: isoDate("dateFrom")
    .optional()
    .describe("Only include messages at or after this ISO 8601 timestamp"),
  dateTo: isoDate("dateTo")
    .optional()
    .describe("Only include messages at or before this ISO 8601 timestamp"),
};

const inputObject = z.object(getSmsConversationInputSchema);
export type GetSmsConversationInput = z.infer<typeof inputObject>;

export interface SmsMessage {
  messageId?: string;
  timestamp?: string;
  direction?: string;
  status?: string;
  readStatus?: string;
  sender: { number?: string; name?: string; extension?: string };
  recipients: Array<{ number?: string; name?: string; extension?: string }>;
  text?: string;
  conversationId?: string;
}

export interface GetSmsConversationResult {
  phoneNumber: string;
  queriedAs: string;
  dateFrom?: string;
  dateTo?: string;
  count: number;
  inbound: number;
  outbound: number;
  pagesFetched: number;
  truncated: boolean;
  messages: SmsMessage[];
}

export async function getSmsConversation(
  input: GetSmsConversationInput,
): Promise<GetSmsConversationResult> {
  const { phoneNumber, dateFrom, dateTo } = input;

  const queriedAs = toApiPhoneNumber(phoneNumber);
  if (queriedAs.length < 3) {
    throw new Error(`phoneNumber "${phoneNumber}" contains too few digits to search.`);
  }

  let fetched;
  try {
    fetched = await fetchMessages({
      messageType: "SMS",
      phoneNumber: queriedAs,
      dateFrom,
      dateTo,
      perPage: PAGE_SIZE,
    });
  } catch (error) {
    rethrowWithScopeHint(error, "ReadMessages");
  }

  const messages: SmsMessage[] = fetched.messages.map((message) => ({
    messageId: message.id,
    timestamp: message.timestamp,
    direction: message.direction,
    status: message.status,
    readStatus: message.readStatus,
    sender: message.from,
    recipients: message.to,
    // RingCentral carries SMS body text in `subject`.
    text: message.subject,
    conversationId: message.conversationId,
  }));

  // Chronological, oldest first — a thread reads top to bottom.
  messages.sort((a, b) => Date.parse(a.timestamp ?? "") - Date.parse(b.timestamp ?? ""));

  return {
    phoneNumber,
    queriedAs,
    dateFrom,
    dateTo,
    count: messages.length,
    inbound: messages.filter((m) => m.direction === "Inbound").length,
    outbound: messages.filter((m) => m.direction === "Outbound").length,
    pagesFetched: fetched.pagesFetched,
    truncated: fetched.truncated,
    messages,
  };
}

export const getSmsConversationToolConfig = {
  title: "Get SMS conversation",
  description:
    "Return the SMS thread with one phone number in chronological order, " +
    "oldest first, with timestamps, direction, sender and delivery status. " +
    "Requires the ReadMessages scope.",
  inputSchema: getSmsConversationInputSchema,
};
