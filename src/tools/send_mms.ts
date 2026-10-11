import { z } from "zod";

import { rcPostForm } from "../ringcentral/client.js";
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
 * `send_mms` — as send_sms, plus media attachments.
 *
 * Same gate: nothing is sent unless ALLOW_REAL_SENDS is set to "true".
 *
 * Attachments arrive base64-encoded because this server may be called over the
 * network, where a local file path would be meaningless.
 */

export const MMS_PATH = "/restapi/v1.0/account/~/extension/~/mms";

const MAX_TEXT_LENGTH = 1000;
/** RingCentral's documented per-message media ceiling. */
const MAX_TOTAL_ATTACHMENT_BYTES = 1_500_000;
const MAX_ATTACHMENTS = 10;

const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/tiff",
  "video/mpeg",
  "video/mp4",
  "audio/mpeg",
  "application/pdf",
];

export const sendMmsInputSchema = {
  to: z
    .string()
    .min(3)
    .describe("Recipient number in E.164 form, e.g. +14155551234."),
  text: z
    .string()
    .max(MAX_TEXT_LENGTH)
    .optional()
    .describe("Optional message body to accompany the media."),
  from: z
    .string()
    .min(3)
    .optional()
    .describe(
      "Sending number. Must be an MMS-enabled number on this extension. " +
        "Omit to use DEFAULT_SMS_FROM.",
    ),
  attachments: z
    .array(
      z.object({
        fileName: z.string().min(1).describe("File name, e.g. photo.jpg"),
        contentType: z
          .string()
          .min(3)
          .describe(`MIME type. One of: ${ALLOWED_CONTENT_TYPES.join(", ")}`),
        contentBase64: z.string().min(1).describe("File contents, base64-encoded"),
      }),
    )
    .min(1)
    .max(MAX_ATTACHMENTS)
    .describe("Media to attach. At least one, or use send_sms instead."),
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

const inputObject = z.object(sendMmsInputSchema);
export type SendMmsInput = z.infer<typeof inputObject>;

export interface SendMmsResult {
  dryRun: boolean;
  /** True when the only thing missing is the user's approval. */
  awaitingConfirmation: boolean;
  reason?: string;
  /** What the assistant must do next. Present when awaiting confirmation. */
  instruction?: string;
  confirmation: {
    to: string;
    from: string;
    senderSource: string;
    text?: string;
    attachments: Array<{ fileName: string; contentType: string; bytes: number }>;
    totalAttachmentBytes: number;
  };
  authorizedSenders: string[];
  /**
   * What was, or would have been, posted. Attachment contents are described
   * rather than echoed — a base64 image would swamp the response.
   */
  request: {
    path: string;
    method: "POST";
    contentType: "multipart/form-data";
    parts: unknown[];
  };
  duplicateWindowSeconds: number;
  messageId?: string;
  messageStatus?: string;
  sentAt?: string;
}

export async function sendMms(input: SendMmsInput): Promise<SendMmsResult> {
  const config = loadOutboundConfig();

  const to = toE164(input.to);
  const sender = await resolveSender(input.from, "MmsSender", config);

  const decoded = input.attachments.map((attachment) => {
    if (!ALLOWED_CONTENT_TYPES.includes(attachment.contentType)) {
      throw new Error(
        `Unsupported attachment type "${attachment.contentType}" for ` +
          `${attachment.fileName}. Allowed: ${ALLOWED_CONTENT_TYPES.join(", ")}.`,
      );
    }

    const bytes = Buffer.from(attachment.contentBase64, "base64");
    if (bytes.length === 0) {
      throw new Error(`Attachment ${attachment.fileName} decoded to zero bytes.`);
    }

    return { ...attachment, bytes };
  });

  const totalBytes = decoded.reduce((sum, a) => sum + a.bytes.length, 0);
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachments total ${totalBytes} bytes, over the ` +
        `${MAX_TOTAL_ATTACHMENT_BYTES}-byte limit for one message.`,
    );
  }

  // Attachment names take part in the key, so resending the same caption with
  // different media is not mistaken for a duplicate.
  const key = duplicateKey(
    "mms",
    [to],
    `${input.text ?? ""}|${decoded.map((a) => `${a.fileName}:${a.bytes.length}`).join(",")}`,
  );
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


  const confirmation = {
    to,
    from: sender.from,
    senderSource: sender.source,
    text: input.text,
    attachments: decoded.map((a) => ({
      fileName: a.fileName,
      contentType: a.contentType,
      bytes: a.bytes.length,
    })),
    totalAttachmentBytes: totalBytes,
  };

  const base = {
    confirmation,
    authorizedSenders: sender.authorized,
    request: {
      path: MMS_PATH,
      method: "POST" as const,
      contentType: "multipart/form-data" as const,
      parts: [
        {
          name: "request",
          contentType: "application/json",
          value: {
            from: { phoneNumber: sender.from },
            to: [{ phoneNumber: to }],
            ...(input.text ? { text: input.text } : {}),
          },
        },
        ...decoded.map((a) => ({
          name: "attachment",
          fileName: a.fileName,
          contentType: a.contentType,
          bytes: a.bytes.length,
        })),
      ],
    },
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
        "number, the message text and each attachment back to them. Do not " +
        "assume approval, and do not send on their behalf without it.",
      ...base,
    };
  }

  const form = new FormData();
  form.append(
    "request",
    new Blob(
      [
        JSON.stringify({
          from: { phoneNumber: sender.from },
          to: [{ phoneNumber: to }],
          ...(input.text ? { text: input.text } : {}),
        }),
      ],
      { type: "application/json" },
    ),
  );
  for (const attachment of decoded) {
    form.append(
      "attachment",
      new Blob([new Uint8Array(attachment.bytes)], { type: attachment.contentType }),
      attachment.fileName,
    );
  }

  let response;
  try {
    response = await rcPostForm<{ id?: number | string; messageStatus?: string; creationTime?: string }>(
      MMS_PATH,
      form,
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

export const sendMmsToolConfig = {
  title: "Send MMS",
  description:
    "Send a picture or media message from a RingCentral number to a real " +
    "person. ALWAYS call this first without confirm (or with confirm: false) " +
    "to get a preview, show that preview to the user — recipient, sending " +
    "number, message text and attachments — and wait for their explicit " +
    "approval. Only then call again with identical arguments plus " +
    "confirm: true to actually send. Never set confirm: true on the first " +
    "call. A preview sends nothing. The sending number is validated against " +
    "the account's MMS-enabled numbers, and an identical message to the same " +
    "recipient is refused within a 600-second window. Requires the SMS scope " +
    "and, for US numbers, A2P 10DLC registration.",
  inputSchema: sendMmsInputSchema,
};
