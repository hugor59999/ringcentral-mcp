import { z } from "zod";

import { fetchMessage, rethrowWithScopeHint } from "../ringcentral/messages.js";

/**
 * `get_message_status` — delivery state of one message.
 *
 * Pending the ReadMessages scope.
 */

export const getMessageStatusInputSchema = {
  messageId: z
    .string()
    .min(1)
    .regex(/^\d+$/, "messageId must be numeric")
    .describe("Message-store id, as returned by get_sms_conversation or get_voicemail."),
};

const inputObject = z.object(getMessageStatusInputSchema);
export type GetMessageStatusInput = z.infer<typeof inputObject>;

/** Plain-language gloss for each state RingCentral reports. */
const STATUS_MEANING: Record<string, string> = {
  Queued: "Accepted by RingCentral and waiting to be sent.",
  Sent: "Handed off to the carrier; delivery not yet confirmed.",
  Delivered: "Confirmed delivered to the recipient.",
  DeliveryFailed: "The carrier could not deliver it.",
  SendingFailed: "RingCentral could not send it.",
  Received: "An inbound message received on this extension.",
};

export interface GetMessageStatusResult {
  messageId: string;
  type?: string;
  direction?: string;
  status?: string;
  statusMeaning?: string;
  /** True for a state that will not change again. */
  terminal: boolean;
  readStatus?: string;
  timestamp?: string;
  from: { number?: string; name?: string; extension?: string };
  to: Array<{ number?: string; name?: string; extension?: string }>;
}

const TERMINAL_STATUSES = new Set([
  "Delivered",
  "DeliveryFailed",
  "SendingFailed",
  "Received",
]);

export async function getMessageStatus(
  input: GetMessageStatusInput,
): Promise<GetMessageStatusResult> {
  const { messageId } = input;

  let message;
  try {
    message = await fetchMessage(messageId);
  } catch (error) {
    rethrowWithScopeHint(error, "ReadMessages");
  }

  return {
    messageId: message.id ?? messageId,
    type: message.type,
    direction: message.direction,
    status: message.status,
    statusMeaning: message.status ? STATUS_MEANING[message.status] : undefined,
    terminal: message.status ? TERMINAL_STATUSES.has(message.status) : false,
    readStatus: message.readStatus,
    timestamp: message.timestamp,
    from: message.from,
    to: message.to,
  };
}

export const getMessageStatusToolConfig = {
  title: "Get message status",
  description:
    "Look up the delivery state of one message: Queued, Sent, Delivered, " +
    "DeliveryFailed, SendingFailed or Received, with a plain-language " +
    "explanation and whether the state is final. Requires the ReadMessages scope.",
  inputSchema: getMessageStatusInputSchema,
};
