import { z } from "zod";

import { getTokenInfo, loadConfig } from "../ringcentral/auth.js";
import { loadPlaybackConfig } from "../http/playback.js";
import { buildSignedPlaybackUrl } from "../http/signing.js";
import { rcGet, RingCentralApiError } from "../ringcentral/client.js";

/**
 * `get_call_recording` — metadata plus a playable URL for one call recording.
 *
 * Playback goes through this server's own proxy via a short-lived signed link
 * (`GET /recording/:id?exp=&sig=`) rather than a RingCentral URL. The
 * RingCentral access token is an account-wide credential and never leaves the
 * server — it is not embedded in any URL this tool returns.
 */

const RECORDING_PATH = (id: string) => `/restapi/v1.0/account/~/recording/${id}`;

/**
 * Mints a signed, time-limited playback link for a recording id.
 *
 * Needs no API call — the proxy resolves the recording when the link is
 * opened — so callers holding a recordingId from a call-log record (e.g. the
 * timeline provider) can use this directly.
 */
export function buildRecordingPlaybackUrl(recordingId: string): {
  url: string;
  expiresAt: string;
} {
  const { baseUrl, signingSecret, linkTtlSeconds } = loadPlaybackConfig();
  return buildSignedPlaybackUrl(baseUrl, recordingId, linkTtlSeconds, signingSecret);
}

export const getCallRecordingInputSchema = {
  recordingId: z
    .string()
    .min(1)
    .regex(/^\d+$/, "recordingId must be numeric, e.g. 1234567890123")
    .describe(
      "RingCentral recording id, as returned in the recordingId field of " +
        "get_call_history results where hasRecording is true.",
    ),
};

const inputObject = z.object(getCallRecordingInputSchema);
export type GetCallRecordingInput = z.infer<typeof inputObject>;

interface RecordingMetadata {
  id?: string;
  contentUri?: string;
  contentType?: string;
  duration?: number;
}

export interface CallRecordingResult {
  recordingId: string;
  contentType?: string;
  durationSeconds?: number;
  durationFormatted?: string;
  /**
   * Canonical RingCentral media URL. Requires a RingCentral Authorization
   * header, so it is not directly playable — included for reference only.
   */
  contentUri?: string;
  /**
   * Short-lived signed link to this server's playback proxy. Needs no headers,
   * so it can be opened directly in a browser or used as an <audio> src.
   */
  playbackUrl: string;
  /** When playbackUrl stops working. */
  playbackUrlExpiresAt: string;
  /**
   * When the server-side RingCentral token next expires. The proxy refreshes
   * it automatically, so playbackUrl keeps working across this boundary; it
   * matters only for direct contentUri access.
   */
  ringcentralTokenExpiresAt?: string;
  playbackNote: string;
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

export async function getCallRecording(
  input: GetCallRecordingInput,
): Promise<CallRecordingResult> {
  const { recordingId } = input;

  let metadata: RecordingMetadata;
  try {
    metadata = await rcGet<RecordingMetadata>(RECORDING_PATH(recordingId));
  } catch (error) {
    if (error instanceof RingCentralApiError) {
      if (error.status === 404) {
        throw new Error(
          `Recording ${recordingId} was not found. It may have been deleted, ` +
            `may belong to another account, or the id may be wrong.`,
        );
      }
      if (error.status === 403) {
        throw new Error(
          `Recording ${recordingId} is not accessible with the current ` +
            `credentials. The app needs the ReadCallRecording scope and the ` +
            `recording must belong to this account.`,
        );
      }
    }
    throw error;
  }

  const { serverUrl } = loadConfig();
  const contentUri =
    metadata.contentUri ?? `${serverUrl}${RECORDING_PATH(recordingId)}/content`;

  const info = await getTokenInfo();
  const signed = buildRecordingPlaybackUrl(metadata.id ?? recordingId);

  return {
    recordingId: metadata.id ?? recordingId,
    contentType: metadata.contentType,
    durationSeconds: metadata.duration,
    durationFormatted: formatDuration(metadata.duration),
    contentUri,
    playbackUrl: signed.url,
    playbackUrlExpiresAt: signed.expiresAt,
    ringcentralTokenExpiresAt: info.expiresAt.toISOString(),
    playbackNote:
      "playbackUrl is a signed, time-limited link to this server's playback " +
      "proxy. It needs no headers, so it can be opened directly in a browser, " +
      "and it supports Range requests for seeking. It grants access to this " +
      "one recording until playbackUrlExpiresAt and carries no RingCentral " +
      "credential and no static server token.",
  };
}

export const getCallRecordingToolConfig = {
  title: "Get call recording",
  description:
    "Fetch metadata and a playable URL for a RingCentral call recording by id. " +
    "Recording ids come from get_call_history results where hasRecording is " +
    "true. Returns content type, duration, and a short-lived signed playbackUrl " +
    "served by this server's proxy — openable in a browser, with no " +
    "RingCentral credential exposed.",
  inputSchema: getCallRecordingInputSchema,
};
