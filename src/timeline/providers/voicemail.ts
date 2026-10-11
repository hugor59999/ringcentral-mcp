import { describeScopeError, fetchMessages } from "../../ringcentral/messages.js";
import type { TimelineEvent, TimelineProvider, TimelineProviderResult } from "../types.js";

/**
 * Voicemail provider. Inert until the ReadMessages scope is enabled.
 *
 * Note this is the message-store voicemail record, which carries the
 * transcription and audio attachment — distinct from a call-log entry whose
 * result happens to be "Voicemail".
 */

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

export const voicemailProvider: TimelineProvider = {
  name: "voicemail",
  type: "voicemail",

  async fetch(query): Promise<TimelineProviderResult> {
    let fetched;
    try {
      fetched = await fetchMessages({
        messageType: "VoiceMail",
        phoneNumber: query.phoneNumber,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        perPage: query.perPage,
      });
    } catch (error) {
      const hint = describeScopeError(error, "ReadMessages");
      if (hint) return { events: [], truncated: false, unavailable: hint };
      throw error;
    }

    const events: TimelineEvent[] = fetched.messages.map((message) => {
      const audio = message.attachments.find((a) => a.type === "AudioRecording");
      const who = message.from.name ?? message.from.number ?? "unknown";
      const duration = formatDuration(audio?.vmDuration ?? message.durationSeconds);

      return {
        timestamp: message.timestamp ?? "",
        type: "voicemail",
        direction: message.direction ?? "Inbound",
        participant: message.from,
        summary: [`Voicemail from ${who}`, duration, message.readStatus]
          .filter(Boolean)
          .join(" — "),
        details: {
          messageId: message.id,
          durationSeconds: audio?.vmDuration ?? message.durationSeconds,
          durationFormatted: duration,
          readStatus: message.readStatus,
          transcriptionStatus: message.transcriptionStatus,
          recordingId: audio?.id,
          recordingUri: audio?.uri,
          contentType: audio?.contentType,
          from: message.from,
          to: message.to,
        },
      };
    });

    return {
      events,
      truncated: fetched.truncated,
      stats: { pagesFetched: fetched.pagesFetched, voicemails: events.length },
    };
  },
};
