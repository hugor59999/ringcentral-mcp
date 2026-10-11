import { createHash } from "node:crypto";

import { rcGet } from "./client.js";

/**
 * Shared machinery for outbound messaging.
 *
 * Sending is the only thing this server does that changes the outside world,
 * and a mistake is not recoverable — a text cannot be unsent. Three safeguards
 * sit in front of every send:
 *
 *   1. Real sends are OFF unless ALLOW_REAL_SENDS is explicitly "true".
 *   2. The sender number must be one the account may actually send from.
 *   3. An identical message to the same recipient is refused inside a short
 *      window, so a retry or a confused caller cannot double-send.
 */

/** Capability flags RingCentral reports per phone number. */
export type SendCapability = "SmsSender" | "MmsSender";

/**
 * Default window in which an identical message to the same recipient is
 * refused.
 *
 * It was 60 seconds, which is shorter than how an assistant actually behaves:
 * on 2026-09-21 the same text went out twice, 162 seconds apart, and the guard
 * correctly let the second through because it sat outside the window. Agents
 * retry on the scale of minutes, not seconds, so the window has to match.
 */
export const DEFAULT_DUPLICATE_WINDOW_SECONDS = 600;

export interface OutboundConfig {
  /** Real sends happen only when this is explicitly enabled. */
  allowRealSends: boolean;
  /** Used when a tool call omits `from`. */
  defaultFrom?: string;
  duplicateWindowSeconds: number;
}

export function loadOutboundConfig(env: NodeJS.ProcessEnv = process.env): OutboundConfig {
  // Only the word "true" (any case, spaces trimmed) enables sending. "1",
  // "yes", "on" and typos all mean off — a mistake must fail safe.
  const allowRealSends = (env.ALLOW_REAL_SENDS ?? "").trim().toLowerCase() === "true";

  const defaultFrom = env.DEFAULT_SMS_FROM?.trim() || undefined;

  const duplicateWindowSeconds = Number(
    env.DUPLICATE_SEND_WINDOW_SECONDS ?? DEFAULT_DUPLICATE_WINDOW_SECONDS,
  );
  if (!Number.isFinite(duplicateWindowSeconds) || duplicateWindowSeconds < 0) {
    throw new Error(
      `DUPLICATE_SEND_WINDOW_SECONDS must be a non-negative number, got ` +
        `"${env.DUPLICATE_SEND_WINDOW_SECONDS}".`,
    );
  }

  return { allowRealSends, defaultFrom, duplicateWindowSeconds };
}

// --- phone number handling -------------------------------------------------

/**
 * Normalizes a number to E.164.
 *
 * A bare 10-digit number is assumed to be US/Canada — this account is US-based.
 * Anything else must arrive with a country code, because guessing wrong here
 * means texting a stranger.
 */
export function toE164(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 0) {
    throw new Error(`"${input}" does not contain a phone number.`);
  }

  if (trimmed.startsWith("+")) {
    if (digits.length < 8) {
      throw new Error(`"${input}" is too short to be an international number.`);
    }
    return `+${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;

  throw new Error(
    `"${input}" is ambiguous. Provide it in E.164 form with a country code, ` +
      `e.g. +14155551234.`,
  );
}

// --- authorized senders ----------------------------------------------------

interface PhoneNumberRecord {
  phoneNumber?: string;
  usageType?: string;
  features?: string[];
}

interface PhoneNumberResponse {
  records?: PhoneNumberRecord[];
}

/** Numbers change rarely; cache briefly so validation costs no API call. */
const SENDER_CACHE_MS = 5 * 60_000;
let senderCache: { at: number; records: PhoneNumberRecord[] } | null = null;

async function loadPhoneNumbers(): Promise<PhoneNumberRecord[]> {
  if (senderCache && Date.now() - senderCache.at < SENDER_CACHE_MS) {
    return senderCache.records;
  }
  const response = await rcGet<PhoneNumberResponse>(
    "/restapi/v1.0/account/~/extension/~/phone-number",
    { perPage: 100 },
  );
  const records = response.records ?? [];
  senderCache = { at: Date.now(), records };
  return records;
}

/** Clears the cached number list. Used by tests. */
export function clearSenderCache(): void {
  senderCache = null;
}

/** Every number on the extension that may send with the given capability. */
export async function listAuthorizedSenders(capability: SendCapability): Promise<string[]> {
  const records = await loadPhoneNumbers();
  return records
    .filter((record) => record.features?.includes(capability))
    .map((record) => record.phoneNumber)
    .filter((number): number is string => Boolean(number));
}

export interface ResolvedSender {
  from: string;
  authorized: string[];
  /** How `from` was chosen — useful to echo back for confirmation. */
  source: "explicit" | "default" | "only-authorized";
}

/**
 * Picks and validates the sending number.
 *
 * Never falls back silently: if an explicitly requested number cannot send,
 * that is an error, not a reason to substitute a different one.
 */
export async function resolveSender(
  requested: string | undefined,
  capability: SendCapability,
  config: OutboundConfig,
): Promise<ResolvedSender> {
  const authorized = await listAuthorizedSenders(capability);

  if (authorized.length === 0) {
    throw new Error(
      `No number on this extension is enabled for ${capability}. Add the ` +
        `capability to a number in the RingCentral admin portal first.`,
    );
  }

  const check = (candidate: string, source: ResolvedSender["source"]): ResolvedSender => {
    const normalized = toE164(candidate);
    if (!authorized.includes(normalized)) {
      throw new Error(
        `${normalized} is not authorized to send with ${capability}. ` +
          `Authorized numbers: ${authorized.join(", ")}.`,
      );
    }
    return { from: normalized, authorized, source };
  };

  if (requested) return check(requested, "explicit");
  if (config.defaultFrom) return check(config.defaultFrom, "default");

  if (authorized.length === 1) {
    return { from: authorized[0]!, authorized, source: "only-authorized" };
  }

  throw new Error(
    `No sender specified and DEFAULT_SMS_FROM is not set. This extension has ` +
      `several ${capability} numbers — pass one explicitly as "from": ` +
      `${authorized.join(", ")}.`,
  );
}

// --- duplicate protection --------------------------------------------------

/**
 * Recent sends, keyed by recipient + content. In memory only, so it resets on
 * restart — it guards against an immediate accidental repeat, not against
 * deliberate resending later.
 */
const recentSends = new Map<string, number>();

/**
 * Builds the duplicate-detection key.
 *
 * The comparison ignores case and collapses whitespace: re-sending the same
 * sentence with a capital letter changed is the same message to the person
 * receiving it, and should not slip past the guard. The sending number is
 * deliberately excluded, so switching `from` cannot be used to get around it.
 */
export function duplicateKey(kind: string, to: string[], text: string | undefined): string {
  const canonical = JSON.stringify({
    kind,
    to: [...to].sort(),
    text: (text ?? "").trim().replace(/\s+/g, " ").toLowerCase(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface DuplicateCheck {
  duplicate: boolean;
  secondsAgo?: number;
}

export function checkDuplicate(key: string, windowSeconds: number): DuplicateCheck {
  const previous = recentSends.get(key);
  if (previous === undefined) return { duplicate: false };

  const secondsAgo = (Date.now() - previous) / 1000;
  if (secondsAgo >= windowSeconds) {
    recentSends.delete(key);
    return { duplicate: false };
  }

  return { duplicate: true, secondsAgo: Math.round(secondsAgo * 10) / 10 };
}

/**
 * Records a send attempt. Dry runs are recorded too — otherwise the guard
 * could not be exercised without sending real messages, and a caller looping
 * on previews would see no warning that it is repeating itself.
 */
export function recordSend(key: string): void {
  recentSends.set(key, Date.now());

  // Opportunistic cleanup; the map only ever holds a handful of entries.
  if (recentSends.size > 500) {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, at] of recentSends) {
      if (at < cutoff) recentSends.delete(k);
    }
  }
}

/** Clears the duplicate history. Used by tests. */
export function resetDuplicateGuard(): void {
  recentSends.clear();
}
