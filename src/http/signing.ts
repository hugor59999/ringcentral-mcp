import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived signed playback links.
 *
 * A link carries `exp` (unix seconds) and `sig`, an HMAC-SHA256 over the
 * recording id and that expiry, keyed by SIGNING_SECRET. The secret itself
 * never appears in the URL, so a link is safe to hand to a browser: it grants
 * access to exactly one recording, for a short window, and nothing else.
 */

/**
 * Canonical string that gets signed. The separator matters — plain
 * concatenation would let ("1", 23) and ("12", 3) produce the same input.
 */
function payload(recordingId: string, exp: number): string {
  return `${recordingId}.${exp}`;
}

export function signPlayback(recordingId: string, exp: number, secret: string): string {
  return createHmac("sha256", secret).update(payload(recordingId, exp)).digest("base64url");
}

export type SignatureCheck =
  | { valid: true }
  | { valid: false; reason: "missing" | "malformed" | "expired" | "bad_signature" };

/** Verifies a signed link. Comparison is constant-time. */
export function verifyPlaybackSignature(
  recordingId: string,
  exp: string | null,
  sig: string | null,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): SignatureCheck {
  if (exp === null && sig === null) return { valid: false, reason: "missing" };
  if (exp === null || sig === null) return { valid: false, reason: "malformed" };

  const expiry = Number(exp);
  if (!Number.isInteger(expiry) || expiry <= 0) {
    return { valid: false, reason: "malformed" };
  }

  // Check the signature before the clock: a tampered exp must not be able to
  // report itself as merely "expired".
  const expected = Buffer.from(signPlayback(recordingId, expiry, secret));
  const presented = Buffer.from(sig);
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return { valid: false, reason: "bad_signature" };
  }

  if (expiry <= now) return { valid: false, reason: "expired" };

  return { valid: true };
}

/** Builds a signed URL valid for `ttlSeconds` from now. */
export function buildSignedPlaybackUrl(
  baseUrl: string,
  recordingId: string,
  ttlSeconds: number,
  secret: string,
): { url: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signPlayback(recordingId, exp, secret);

  const url = new URL(`${baseUrl}/recording/${recordingId}`);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);

  return { url: url.toString(), expiresAt: new Date(exp * 1000).toISOString() };
}
