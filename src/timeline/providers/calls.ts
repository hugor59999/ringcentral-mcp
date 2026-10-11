import { fetchCallLog, type NormalizedCall } from "../../ringcentral/call-log.js";
import { buildRecordingPlaybackUrl } from "../../tools/get_call_recording.js";
import type { TimelineEvent, TimelineProvider, TimelineProviderResult } from "../types.js";

/**
 * Call-log provider: every call involving the number becomes one timeline
 * event, enriched with a signed playback link when a recording exists.
 */

function describe(call: NormalizedCall, hasRecording: boolean): string {
  const other = call.direction === "Outbound" ? call.to : call.from;
  const who = other.name ?? other.number ?? other.extension ?? "unknown";
  const preposition = call.direction === "Outbound" ? "to" : "from";
  const parts = [
    `${call.direction ?? "Call"} call ${preposition} ${who}`,
    call.result,
    call.durationFormatted,
  ].filter(Boolean);
  return `${parts.join(" — ")}${hasRecording ? " — recording available" : ""}`;
}

export const callsProvider: TimelineProvider = {
  name: "call-log",
  type: "call",

  async fetch(query): Promise<TimelineProviderResult> {
    const { calls, truncated, pagesFetched } = await fetchCallLog({
      phoneNumber: query.phoneNumber,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      perPage: query.perPage,
    });

    const events: TimelineEvent[] = calls.map((call) => {
      // The other party: whoever is not this extension.
      const participant = call.direction === "Outbound" ? call.to : call.from;

      // Minting a signed link needs no API call — the proxy resolves the
      // recording itself when the link is opened.
      const playback = call.recordingId
        ? buildRecordingPlaybackUrl(call.recordingId)
        : undefined;

      return {
        timestamp: call.startTime ?? "",
        type: "call",
        direction: call.direction,
        participant: {
          number: participant.number,
          name: participant.name,
          extension: participant.extension,
        },
        summary: describe(call, Boolean(call.recordingId)),
        details: {
          callId: call.id,
          result: call.result,
          action: call.action,
          callType: call.type,
          durationSeconds: call.durationSeconds,
          durationFormatted: call.durationFormatted,
          from: call.from,
          to: call.to,
          hasRecording: call.hasRecording,
          ...(call.recordingId ? { recordingId: call.recordingId } : {}),
          ...(playback
            ? {
                playbackUrl: playback.url,
                playbackUrlExpiresAt: playback.expiresAt,
              }
            : {}),
        },
      };
    });

    return { events, truncated, stats: { pagesFetched, calls: calls.length } };
  },
};
