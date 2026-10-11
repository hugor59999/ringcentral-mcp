import { z } from "zod";

import { rcDelete, rcGet, RingCentralApiError } from "../ringcentral/client.js";
import { normalizeRecord, type CallLogRecord, type NormalizedCall } from "../ringcentral/call-log.js";

/**
 * `delete_call_log_entry` — the only destructive tool in this server.
 *
 * Deleting a call-log entry removes the WHOLE record — the call's history and
 * its recording reference, not just the audio — and it cannot be undone from
 * here. Four guards sit in front of it:
 *
 *   1. Exactly one id. The schema takes a single string; arrays, comma or
 *      newline separated lists, and blanks are rejected before anything runs.
 *   2. The entry is fetched and returned first. Without `confirm: true` the
 *      tool previews the record and deletes nothing.
 *   3. `confirm` applies to the id in the same call, so a confirmation can
 *      never be carried over onto a different record.
 *   4. ALLOW_DELETIONS must be enabled on the server, exactly as sends are
 *      gated by ALLOW_REAL_SENDS.
 */

const CALL_LOG_ENTRY = (id: string) => `/restapi/v1.0/account/~/extension/~/call-log/${id}`;

/** Anything that suggests more than one id was passed. */
const BULK_HINT = /[,;\s]/;

export function allowDeletions(env: NodeJS.ProcessEnv = process.env): boolean {
  // Only the word "true" enables deletion. Typos and truthy-looking values
  // must fail closed.
  return (env.ALLOW_DELETIONS ?? "").trim().toLowerCase() === "true";
}

export const deleteCallLogEntryInputSchema = {
  callId: z
    .string()
    .min(1, "callId is required and cannot be blank.")
    .refine((value) => value.trim().length > 0, {
      message: "callId is required and cannot be blank.",
    })
    .refine((value) => !BULK_HINT.test(value.trim()), {
      message:
        "Only one call id may be deleted per call. Lists, ranges and bulk " +
        "deletion are not supported — delete one entry at a time, confirming " +
        "each.",
    })
    .describe(
      "The id of a single call-log entry, as returned in the `id` field of " +
        "get_call_history results. Exactly one id — lists are rejected.",
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Must be true to actually delete. Leave false (the default) to preview " +
        "the entry first. Always preview before confirming.",
    ),
};

const inputObject = z.object(deleteCallLogEntryInputSchema);
export type DeleteCallLogEntryInput = z.infer<typeof inputObject>;

export interface DeleteCallLogEntryResult {
  callId: string;
  /** True when nothing was deleted. */
  deleted: boolean;
  /** Why nothing was deleted, when that is the case. */
  reason?: string;
  /** What this entry is — always returned, so a deletion is never blind. */
  entry: NormalizedCall;
  /** Plain-language summary of the record for confirmation. */
  summary: string;
  warning: string;
  /** After a real delete: whether the record is still retrievable. */
  verified?: "gone" | "still-present" | "unchecked";
}

function describe(call: NormalizedCall): string {
  const other = call.direction === "Outbound" ? call.to : call.from;
  const who = other.name ?? other.number ?? other.extension ?? "unknown";
  const preposition = call.direction === "Outbound" ? "to" : "from";
  return [
    `${call.direction ?? "Call"} call ${preposition} ${who}`,
    other.number && other.name ? other.number : undefined,
    call.startTime,
    call.result,
    call.durationFormatted,
    call.hasRecording ? "has a recording" : undefined,
  ]
    .filter(Boolean)
    .join(" — ");
}

const WARNING =
  "Deleting removes the ENTIRE call-log entry — the call's history and its " +
  "recording reference, not just the audio. It cannot be undone from this " +
  "server.";

export async function deleteCallLogEntry(
  input: DeleteCallLogEntryInput,
): Promise<DeleteCallLogEntryResult> {
  const callId = input.callId.trim();

  // Fetch first, always. A deletion is never performed on an unseen record.
  let record: CallLogRecord;
  try {
    record = await rcGet<CallLogRecord>(CALL_LOG_ENTRY(callId));
  } catch (error) {
    if (error instanceof RingCentralApiError && error.status === 404) {
      throw new Error(
        `No call-log entry with id "${callId}". It may already have been ` +
          `deleted, or the id may be wrong. Ids come from get_call_history.`,
      );
    }
    throw error;
  }

  const entry = normalizeRecord(record);
  const summary = describe(entry);

  const base = { callId, entry, summary, warning: WARNING };

  if (!input.confirm) {
    return {
      ...base,
      deleted: false,
      reason:
        `Preview only — nothing was deleted. This is the entry that would be ` +
        `removed. To delete it, call again with callId "${callId}" and ` +
        `confirm: true.`,
    };
  }

  if (!allowDeletions()) {
    return {
      ...base,
      deleted: false,
      reason:
        "Deletion is disabled on this server (ALLOW_DELETIONS is not enabled), " +
        "so nothing was deleted even though confirm was set. This is the entry " +
        "that would have been removed. An administrator must set " +
        "ALLOW_DELETIONS=true and restart to permit deletions.",
    };
  }

  await rcDelete(CALL_LOG_ENTRY(callId));

  // Confirm it actually went, rather than assuming a 204 means gone.
  let verified: DeleteCallLogEntryResult["verified"] = "unchecked";
  try {
    await rcGet<CallLogRecord>(CALL_LOG_ENTRY(callId));
    verified = "still-present";
  } catch (error) {
    verified = error instanceof RingCentralApiError && error.status === 404 ? "gone" : "unchecked";
  }

  return { ...base, deleted: true, verified };
}

export const deleteCallLogEntryToolConfig = {
  title: "Delete a call-log entry",
  description:
    "Delete ONE call-log entry by id. DESTRUCTIVE: this removes the entire " +
    "call record — its history and its recording reference, not just the " +
    "audio — and cannot be undone. Called without confirm, it returns the " +
    "entry's details (caller, number, date, id) and deletes nothing; always " +
    "preview first and show the user what will be removed. Only one id per " +
    "call: lists and bulk deletion are rejected. Deletion must also be " +
    "enabled on the server via ALLOW_DELETIONS.",
  inputSchema: deleteCallLogEntryInputSchema,
};
