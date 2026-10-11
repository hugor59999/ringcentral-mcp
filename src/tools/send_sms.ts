import { z } from "zod";

import { rcPostJson } from "../ringcentral/client.js";
import { rethrowWithScopeHint } from "../ringcentral/messages.js";
import {
  checkDuplicate,
  duplicateKey,
  loadOutboundConfig,
  recordSend,
  resolveSender,
  toE164,
} from "../ringcentral/outbound.js";

/**
 * `send_sms` — the first tool that changes anything outside this server.
 *
 * Real sending is OFF unless ALLOW_REAL_SENDS is set to "true" (any case). With
 * it off,
 * everything runs — validation, sender authorization, duplicate checking, and
 * building the exact request body — and the request is returned as a preview
 * instead of being posted.
 */

export const SMS_PATH = "/restapi/v1.0/account/~/extension/~/sms";

/** RingCentral splits longer texts into segments; this is the hard ceiling. */
const MAX_TEXT_LENGTH = 1000;

export const sendSmsInputSchema = {
  to: z
    .string()
    .min(3)
    .describe(
      "Recipient number in E.164 form, e.g. +14155551234. A 10-digit number " +
        "is treated as US/Canada.",
    ),
  text: z
    .string()
    .min(1)
    .max(MAX_TEXT_LENGTH)
    .describe("Message body."),
  from: z
    .string()
    .min(3)
    .optional()
    .describe(
      "Sending number. Must be an SMS-enabled number on this extension. " +
        "Omit to use DEFAULT_SMS_FROM.",
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Must be true to actually send. Leave false (the default) to get a " +
        "preview of exactly what would be sent. Always preview first, show it " +
        "to the user, and only call again with confirm: true once they have " +
        "approved it.",
    ),
};

const inputObject = z.object(sendSmsInputSchema);
export type SendSmsInput = z.infer<typeof inputObject>;

export interface SendSmsResult {
  /** True when nothing was actually sent. */
  dryRun: boolean;
  /** True when the only thing missing is the user's approval. */
  awaitingConfirmation: boolean;
  /** Present when nothing was sent — why. */
  reason?: string;
  /** What the assistant must do next. Present when awaiting confirmation. */
  instruction?: string;
  confirmation: {
    to: string;
    from: string;
    senderSource: string;
    text: string;
    textLength: number;
  };
  authorizedSenders: string[];
  /** The exact body that was, or would have been, posted. */
  request: { path: string; method: "POST"; body: unknown };
  duplicateWindowSeconds: number;
  /** Present only on a real send. */
  messageId?: string;
  messageStatus?: string;
  sentAt?: string;
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const config = loadOutboundConfig();

  const to = toE164(input.to);
  const text = input.text;

  // Resolved before the preview, so the user is shown the number the message
  // would genuinely go out from, not a guess.
  const sender = await resolveSender(input.from, "SmsSender", config);

  // Checked before the confirmation gate: if an identical message really went
  // out minutes ago, saying so is more useful than previewing it again.
  const key = duplicateKey("sms", [to], text);
  const duplicate = checkDuplicate(key, config.duplicateWindowSeconds);
  if (duplicate.duplicate) {
    // Phrased so the model understands nothing was sent and that retrying the
    // same text will not help — otherwise it tends to try again immediately.
    throw new Error(
      `Identical text already sent to ${to} ${duplicate.secondsAgo} seconds ago, ` +
        `not re-sent. This is a duplicate-send guard covering a ` +
        `${config.duplicateWindowSeconds}-second window; the earlier message was ` +
        `delivered, so do not retry. Change the wording, wait for the window to ` +
        `pass, or confirm with the user that a second identical message is really ` +
        `wanted. (Comparison ignores capitalisation.)`,
    );
  }

  const body = {
    from: { phoneNumber: sender.from },
    to: [{ phoneNumber: to }],
    text,
  };

  const confirmation = {
    to,
    from: sender.from,
    senderSource: sender.source,
    text,
    textLength: text.length,
  };

  const base = {
    confirmation,
    authorizedSenders: sender.authorized,
    request: { path: SMS_PATH, method: "POST" as const, body },
    duplicateWindowSeconds: config.duplicateWindowSeconds,
  };

  // The server cannot send at all — say so rather than asking for an approval
  // that would change nothing.
  if (!config.allowRealSends) {
    return {
      dryRun: true,
      awaitingConfirmation: false,
      reason:
        "ALLOW_REAL_SENDS is not enabled on this server, so nothing was sent " +
        "and confirming would not change that. This is the exact request that " +
        "would have been posted.",
      ...base,
    };
  }

  if (!input.confirm) {
    // Nothing is recorded here: a preview must not trip the duplicate guard on
    // the confirmed call that follows it.
    return {
      dryRun: true,
      awaitingConfirmation: true,
      reason: "Not sent — awaiting the user's approval.",
      instruction:
        "Show this preview to the user and ask for explicit approval before " +
        "calling again with confirm: true. Repeat the recipient, the sending " +
        "number and the full message text back to them verbatim. Do not assume " +
        "approval, and do not send on their behalf without it.",
      ...base,
    };
  }

  let response;
  try {
    response = await rcPostJson<{ id?: number | string; messageStatus?: string; creationTime?: string }>(
      SMS_PATH,
      body,
    );
  } catch (error) {
    rethrowWithScopeHint(error, "SMS");
  }

  // Recorded only once a message has genuinely left the server.
  recordSend(key);

  return {
    dryRun: false,
    awaitingConfirmation: false,
    ...base,
    messageId: response.id === undefined ? undefined : String(response.id),
    messageStatus: response.messageStatus,
    sentAt: response.creationTime,
  };
}

export const sendSmsToolConfig = {
  title: "Send SMS",
  description:
    "Send a text message from a RingCentral number to a real person. " +
    "ALWAYS call this first without confirm (or with confirm: false) to get a " +
    "preview, show that preview to the user — recipient, sending number and " +
    "the full message text — and wait for their explicit approval. Only then " +
    "call again with identical arguments plus confirm: true to actually send. " +
    "Never set confirm: true on the first call, and never infer approval from " +
    "an earlier instruction. A preview sends nothing. The sending number is " +
    "validated against the account's SMS-enabled numbers, and an identical " +
    "message to the same recipient is refused within a 600-second window. " +
    "Requires the SMS scope and, for US numbers, A2P 10DLC registration.",
  inputSchema: sendSmsInputSchema,
};
