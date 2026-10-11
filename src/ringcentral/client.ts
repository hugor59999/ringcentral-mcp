import { clearTokenCache, getAccessToken, loadConfig } from "./auth.js";

/**
 * Thin HTTP wrapper for the RingCentral REST API.
 *
 * Adds the bearer token, and retries on rate limiting (429) and transient
 * server errors with exponential backoff, honouring `Retry-After` when the
 * API sends it.
 */

/**
 * Client-side rate limiting.
 *
 * RingCentral's call-log and message-store endpoints sit in its "Heavy" group,
 * roughly 10 requests per minute. A paginating tool, or the timeline running
 * several providers, can burst past that in a couple of seconds and trip a 429
 * — which then costs a full 60-second Retry-After wait.
 *
 * A shared sliding-window limiter spaces requests to stay under the limit in
 * the first place. The 429 backoff below remains underneath as the safety net:
 * the limiter reduces how often we hit it, the backoff handles it when we do.
 */
const RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 8;

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1_000;
/** Ceiling for our own exponential backoff. */
const MAX_BACKOFF_MS = 30_000;
/**
 * Separate, higher ceiling for a server-supplied Retry-After. The call-log
 * endpoint is in RingCentral's "Heavy" rate-limit group (~10 requests/minute)
 * and answers a 429 with `Retry-After: 60`. Clamping that down to our own
 * backoff ceiling just retries inside the same window and burns the budget.
 */
const MAX_RETRY_AFTER_MS = 120_000;

function loadMaxRequestsPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RC_MAX_REQUESTS_PER_MINUTE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_REQUESTS_PER_MINUTE;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `RC_MAX_REQUESTS_PER_MINUTE must be a non-negative number, got "${raw}". ` +
        `Use 0 to disable client-side throttling.`,
    );
  }
  return value;
}

let maxRequestsPerMinute = loadMaxRequestsPerMinute();

/** Timestamps of recent requests, oldest first. */
const requestTimes: number[] = [];
/** Serializes slot acquisition so concurrent callers cannot all pass at once. */
let acquireChain: Promise<void> = Promise.resolve();

/** Overrides the configured rate. Used by tests. */
export function setMaxRequestsPerMinute(value: number): void {
  maxRequestsPerMinute = value;
}

export interface ThrottleState {
  maxRequestsPerMinute: number;
  /** Requests issued within the current sliding window. */
  inWindow: number;
}

export function getThrottleState(): ThrottleState {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  return {
    maxRequestsPerMinute,
    inWindow: requestTimes.filter((at) => at > cutoff).length,
  };
}

/** Forgets recent request history. Used by tests. */
export function resetThrottle(): void {
  requestTimes.length = 0;
}

/**
 * Waits until issuing another request keeps us within
 * `maxRequestsPerMinute` over any rolling 60-second window.
 */
function acquireSlot(): Promise<void> {
  const acquired = acquireChain.then(async () => {
    if (maxRequestsPerMinute <= 0) return;

    for (;;) {
      const now = Date.now();
      while (requestTimes.length > 0 && now - requestTimes[0]! >= RATE_WINDOW_MS) {
        requestTimes.shift();
      }

      if (requestTimes.length < maxRequestsPerMinute) {
        requestTimes.push(now);
        return;
      }

      // Wait for the oldest request to age out of the window.
      const waitMs = RATE_WINDOW_MS - (now - requestTimes[0]!) + 10;
      console.error(
        `[ringcentral] throttling: ${requestTimes.length}/${maxRequestsPerMinute} ` +
          `requests used this minute; waiting ${Math.round(waitMs / 100) / 10}s`,
      );
      await sleep(waitMs);
    }
  });

  // Keep the chain alive even if a waiter is abandoned.
  acquireChain = acquired.catch(() => undefined);
  return acquired;
}

export class RingCentralApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = "RingCentralApiError";
  }
}

function parseErrorBody(raw: string, status: number): RingCentralApiError {
  try {
    const parsed = JSON.parse(raw) as {
      message?: string;
      errorCode?: string;
      errors?: Array<{ errorCode?: string; message?: string }>;
    };
    const first = parsed.errors?.[0];
    const message = parsed.message ?? first?.message ?? raw.slice(0, 300);
    const code = parsed.errorCode ?? first?.errorCode;
    return new RingCentralApiError(
      `RingCentral API error (HTTP ${status})${code ? ` [${code}]` : ""}: ${message}`,
      status,
      code,
    );
  } catch {
    return new RingCentralApiError(
      `RingCentral API error (HTTP ${status}): ${raw.slice(0, 300)}`,
      status,
    );
  }
}

/** Milliseconds to wait before retry `attempt` (0-based), honouring Retry-After. */
function backoffDelay(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      // Honour the server's own figure; do not shorten it.
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  const exponential = BASE_BACKOFF_MS * 2 ** attempt;
  // Jitter avoids synchronised retries when several calls are throttled at once.
  return Math.min(exponential + Math.random() * 250, MAX_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET a RingCentral API path (e.g. `/restapi/v1.0/account/~/extension/~`)
 * and return the parsed JSON body.
 */
export async function rcGet<T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<T> {
  return rcRequest<T>(path, query, "json");
}

/** As rcGet, but returns the raw body — for text attachments like transcripts. */
export async function rcGetText(
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<string> {
  return rcRequest<string>(path, query, "text");
}

/** POST a JSON body and return the parsed JSON response. */
export async function rcPostJson<T>(path: string, body: unknown): Promise<T> {
  return rcRequest<T>(path, {}, "json", {
    method: "POST",
    body: JSON.stringify(body),
    contentType: "application/json",
  });
}

/**
 * POST a multipart body (MMS attachments). `FormData` sets its own
 * Content-Type with the boundary, so none is supplied here.
 */
export async function rcPostForm<T>(path: string, form: FormData): Promise<T> {
  return rcRequest<T>(path, {}, "json", { method: "POST", body: form });
}

/**
 * DELETE a resource. Returns nothing — RingCentral answers 204 No Content.
 *
 * Goes through the same throttle and error handling as every other call.
 */
export async function rcDelete(path: string): Promise<void> {
  await rcRequest<undefined>(path, {}, "empty", { method: "DELETE" });
}

interface RequestBody {
  method: "POST" | "DELETE";
  body?: NonNullable<RequestInit["body"]>;
  contentType?: string;
}

async function rcRequest<T>(
  path: string,
  query: Record<string, string | number | undefined>,
  as: "json" | "text" | "empty",
  send?: RequestBody,
): Promise<T> {
  const { serverUrl } = loadConfig();

  const url = new URL(path, serverUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError: RingCentralApiError | undefined;
  /**
   * A 401 means the cached access token is no longer accepted — revoked,
   * or invalidated because the app's permissions changed. Renewal is otherwise
   * purely time-based, so without this the server would keep presenting the
   * dead token until it expires naturally, up to an hour later, failing every
   * call in between. Allowed once: a genuinely bad JWT must not loop.
   */
  let tokenRefreshed = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Every attempt, including retries, consumes a slot.
    await acquireSlot();

    const token = await getAccessToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (send?.contentType) headers["Content-Type"] = send.contentType;

    const response = await fetch(url, {
      method: send?.method ?? "GET",
      headers,
      body: send?.body,
    });

    if (response.ok) {
      if (as === "empty") {
        // Drain the body so the connection can be reused, then discard it.
        await response.text();
        return undefined as T;
      }
      if (as === "text") return (await response.text()) as T;

      // A 204, or any empty body, would otherwise blow up JSON.parse.
      const raw = await response.text();
      return (raw.trim() === "" ? undefined : JSON.parse(raw)) as T;
    }

    const raw = await response.text();
    lastError = parseErrorBody(raw, response.status);

    // Every non-2xx is logged: status, RingCentral error code and path. None
    // of these carry a credential. Without this, failures reached the model as
    // tool text and left no trace on the server at all.
    console.error(
      `[ringcentral] HTTP ${response.status} on ${url.pathname}` +
        `${lastError.errorCode ? ` [${lastError.errorCode}]` : ""}` +
        ` (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
    );

    if (response.status === 401 && !tokenRefreshed && attempt < MAX_RETRIES) {
      tokenRefreshed = true;
      console.error(
        `[ringcentral] access token rejected; discarding it and retrying once ` +
          `with a freshly exchanged one`,
      );
      clearTokenCache();
      continue;
    }

    // A write is only retried on rate limiting. Retrying a 5xx could repeat
    // the operation — the server may have accepted it before failing.
    const retryable = send
      ? response.status === 429
      : response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_RETRIES) {
      throw lastError;
    }

    const retryAfterHeader = response.headers.get("retry-after");
    const delay = backoffDelay(attempt, retryAfterHeader);
    console.error(
      `[ringcentral] retrying in ${Math.round(delay / 1000)}s` +
        `${retryAfterHeader ? ` (Retry-After: ${retryAfterHeader}s)` : ""}`,
    );
    await sleep(delay);
  }

  throw lastError ?? new RingCentralApiError("Request failed", 0);
}
