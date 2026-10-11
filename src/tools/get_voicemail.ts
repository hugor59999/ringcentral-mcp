import { z } from "zod";

import { rcGetText } from "../ringcentral/client.js";
import {
  fetchMessages,
  rethrowWithScopeHint,
  toApiPhoneNumber,
  type MessageAttachment,
} from "../ringcentral/messages.js";

/**
 * `get_voicemail` — voicemail messages, with transcription where available.
 *
 * Pending the ReadMessages scope; until it is enabled every call returns the
 * scope hint rather than a raw 403.
 */

const PAGE_SIZE = 100;

/** Transcripts are separate GETs, so cap them to protect the rate budget. */
const MAX_TRANSCRIPT_FETCHES = 10;

const isoDate = (label: string) =>
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: `${label} must be an ISO 8601 date-time, e.g. 2026-08-01T00:00:00Z`,
  });

export const getVoicemailInputSchema = {
  phoneNumber: z
    .string()
    .min(3)
    .optional()
    .describe("Optional caller to filter by. Omit for all voicemail."),
  dateFrom: isoDate("dateFrom")
    .optional()
    .describe("Only include voicemail at or after this ISO 8601 timestamp"),
  dateTo: isoDate("dateTo")
    .optional()
    .describe("Only include voicemail at or before this ISO 8601 timestamp"),
};

const inputObject = z.object(getVoicemailInputSchema);
export type GetVoicemailInput = z.infer<typeof inputObject>;

export interface VoicemailItem {
  messageId?: string;
  timestamp?: string;
  direction?: string;
  readStatus?: string;
  from: { number?: string; name?: string; extension?: string };
  to: Array<{ number?: string; name?: string; extension?: string }>;
  durationSeconds?: number;
  transcriptionStatus?: string;
  transcription?: string;
  /** Attachment holding the audio — use with the message-store content API. */
  recordingId?: string;
  recordingUri?: string;
  contentType?: string;
}

export interface GetVoicemailResult {
  phoneNumber?: string;
  queriedAs?: string;
  dateFrom?: string;
  dateTo?: string;
  count: number;
  pagesFetched: number;
  truncated: boolean;
  /** True when some transcripts were skipped by MAX_TRANSCRIPT_FETCHES. */
  transcriptsTruncated: boolean;
  voicemails: VoicemailItem[];
}

function audioAttachment(attachments: MessageAttachment[]): MessageAttachment | undefined {
  return attachments.find((a) => a.type === "AudioRecording");
}

function transcriptAttachment(
  attachments: MessageAttachment[],
): MessageAttachment | undefined {
  return attachments.find((a) => a.type === "AudioTranscription");
}

export async function getVoicemail(input: GetVoicemailInput): Promise<GetVoicemailResult> {
  const { phoneNumber, dateFrom, dateTo } = input;

  let queriedAs: string | undefined;
  if (phoneNumber !== undefined) {
    queriedAs = toApiPhoneNumber(phoneNumber);
    if (queriedAs.length < 3) {
      throw new Error(`phoneNumber "${phoneNumber}" contains too few digits to search.`);
    }
  }

  let fetched;
  try {
    fetched = await fetchMessages({
      messageType: "VoiceMail",
      phoneNumber: queriedAs,
      dateFrom,
      dateTo,
      perPage: PAGE_SIZE,
    });
  } catch (error) {
    rethrowWithScopeHint(error, "ReadMessages");
  }

  const voicemails: VoicemailItem[] = [];
  let transcriptFetches = 0;
  let transcriptsTruncated = false;

  for (const message of fetched.messages) {
    const audio = audioAttachment(message.attachments);
    const transcript = transcriptAttachment(message.attachments);

    let transcription: string | undefined;
    if (transcript?.uri) {
      if (transcriptFetches < MAX_TRANSCRIPT_FETCHES) {
        transcriptFetches++;
        try {
          // The attachment uri is absolute; rcGetText resolves it as-is.
          transcription = (await rcGetText(transcript.uri)).trim() || undefined;
        } catch {
          // A transcript that will not load must not sink the whole listing.
          transcription = undefined;
        }
      } else {
        transcriptsTruncated = true;
      }
    }

    voicemails.push({
      messageId: message.id,
      timestamp: message.timestamp,
      direction: message.direction,
      readStatus: message.readStatus,
      from: message.from,
      to: message.to,
      durationSeconds: audio?.vmDuration ?? message.durationSeconds,
      transcriptionStatus: message.transcriptionStatus,
      transcription,
      recordingId: audio?.id,
      recordingUri: audio?.uri,
      contentType: audio?.contentType,
    });
  }

  // Oldest first, matching the timeline convention.
  voicemails.sort((a, b) => Date.parse(a.timestamp ?? "") - Date.parse(b.timestamp ?? ""));

  return {
    phoneNumber,
    queriedAs,
    dateFrom,
    dateTo,
    count: voicemails.length,
    pagesFetched: fetched.pagesFetched,
    truncated: fetched.truncated,
    transcriptsTruncated,
    voicemails,
  };
}

export const getVoicemailToolConfig = {
  title: "Get voicemail",
  description:
    "List voicemail messages with caller, timestamp, duration, transcription " +
    "where RingCentral produced one, and a reference to the audio attachment. " +
    "Optionally filtered by caller and date range. Requires the ReadMessages " +
    "scope.",
  inputSchema: getVoicemailInputSchema,
};
