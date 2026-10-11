import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

import { getAccessToken, loadConfig } from "../ringcentral/auth.js";
import { rcGet, RingCentralApiError } from "../ringcentral/client.js";
import { verifyPlaybackSignature } from "./signing.js";

/**
 * Playback proxy.
 *
 * Streams call recordings to callers authenticated one of two ways:
 *
 *  - `Authorization: Bearer $PLAYBACK_AUTH_TOKEN` — for programmatic access.
 *  - a short-lived signed link (`?exp=&sig=`) — for browsers, which cannot
 *    attach headers to an <audio> element or a plain click.
 *
 * The RingCentral access token is used server-side only and never appears in a
 * URL, a response body, or a response header.
 *
 * Runs alongside the stdio MCP transport, so nothing here may write to stdout.
 */

const RECORDING_ROUTE = /^\/recording\/(\d+)$/;

export interface PlaybackConfig {
  authToken: string;
  signingSecret: string;
  linkTtlSeconds: number;
  baseUrl: string;
  port: number;
  bindAddress: string;
}

export function loadPlaybackConfig(env: NodeJS.ProcessEnv = process.env): PlaybackConfig {
  const authToken = env.PLAYBACK_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error(
      "PLAYBACK_AUTH_TOKEN is not set. The playback proxy refuses to start " +
        "without it — an unauthenticated endpoint would expose call recordings.",
    );
  }

  const signingSecret = env.SIGNING_SECRET?.trim();
  if (!signingSecret) {
    throw new Error(
      "SIGNING_SECRET is not set. It is required to mint and verify " +
        "short-lived playback links.",
    );
  }

  const linkTtlSeconds = Number(env.PLAYBACK_LINK_TTL_SECONDS ?? 900);
  if (!Number.isInteger(linkTtlSeconds) || linkTtlSeconds < 1) {
    throw new Error(
      `PLAYBACK_LINK_TTL_SECONDS must be a positive integer, got "${env.PLAYBACK_LINK_TTL_SECONDS}".`,
    );
  }

  const port = Number(env.PLAYBACK_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PLAYBACK_PORT must be a valid port number, got "${env.PLAYBACK_PORT}".`);
  }

  const baseUrl = (env.PLAYBACK_BASE_URL?.trim() || `http://localhost:${port}`).replace(
    /\/+$/,
    "",
  );

  /**
   * Loopback by default, so a bare `npm start` never exposes recordings.
   *
   * Inside Docker this MUST be 0.0.0.0: the published-port proxy connects to
   * the container's eth0 address, so a process bound to the container's
   * loopback is unreachable from the host. Confinement there comes from the
   * `127.0.0.1:PORT:PORT` host mapping instead.
   */
  const bindAddress = env.PLAYBACK_BIND_ADDRESS?.trim() || "127.0.0.1";

  return { authToken, signingSecret, linkTtlSeconds, baseUrl, port, bindAddress };
}

/** Constant-time token comparison, so a wrong token leaks no timing signal. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAuthorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return tokenMatches(match[1]!.trim(), expected);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

async function handleRecording(
  recordingId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // Resolve the media URL for this recording. A missing recording 404s here.
  let contentUri: string;
  try {
    const metadata = await rcGet<{ contentUri?: string }>(
      `/restapi/v1.0/account/~/recording/${recordingId}`,
    );
    const { serverUrl } = loadConfig();
    contentUri =
      metadata.contentUri ??
      `${serverUrl}/restapi/v1.0/account/~/recording/${recordingId}/content`;
  } catch (error) {
    if (error instanceof RingCentralApiError && (error.status === 404 || error.status === 403)) {
      sendJson(response, 404, {
        error: "not_found",
        message: `Recording ${recordingId} was not found or is not accessible.`,
      });
      return;
    }
    throw error;
  }

  // Fetch the audio with the RingCentral token — server-side only.
  const token = await getAccessToken();
  const upstreamHeaders: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (request.headers.range) {
    upstreamHeaders.Range = request.headers.range;
  }

  const upstream = await fetch(contentUri, { headers: upstreamHeaders });

  if (upstream.status === 404 || upstream.status === 403) {
    sendJson(response, 404, {
      error: "not_found",
      message: `Recording ${recordingId} was not found or is not accessible.`,
    });
    return;
  }

  if (!upstream.ok && upstream.status !== 206) {
    // Pass the upstream signal through rather than pretending to serve audio.
    // The media host rate-limits separately and sends Retry-After.
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) response.setHeader("Retry-After", retryAfter);
    sendJson(response, upstream.status === 429 ? 429 : 502, {
      error: upstream.status === 429 ? "rate_limited" : "upstream_error",
      message: `RingCentral media returned HTTP ${upstream.status}.`,
    });
    return;
  }

  // Copy only the headers a player needs. Nothing from the upstream auth path
  // is forwarded.
  const headers: Record<string, string> = {
    "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers["Content-Length"] = contentLength;
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers["Content-Range"] = contentRange;

  response.writeHead(upstream.status, headers);

  if (!upstream.body) {
    response.end();
    return;
  }

  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
}

export function createPlaybackServer(config: PlaybackConfig): Server {
  return createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://localhost:${config.port}`);

        if (request.method !== "GET" && request.method !== "HEAD") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }

        const route = RECORDING_ROUTE.exec(url.pathname);
        if (!route) {
          sendJson(response, 404, { error: "not_found", message: "Unknown path." });
          return;
        }

        const recordingId = route[1]!;

        // Either a valid header token or a valid signed link gets through.
        if (!isAuthorized(request, config.authToken)) {
          const check = verifyPlaybackSignature(
            recordingId,
            url.searchParams.get("exp"),
            url.searchParams.get("sig"),
            config.signingSecret,
          );

          if (!check.valid) {
            response.setHeader("WWW-Authenticate", 'Bearer realm="recording"');
            const messages: Record<typeof check.reason, string> = {
              missing:
                "Provide either Authorization: Bearer <playback token> or a " +
                "signed link with ?exp=&sig=.",
              malformed: "The signed link is malformed.",
              expired: "This playback link has expired. Request a new one.",
              bad_signature: "The playback link signature is not valid.",
            };
            sendJson(response, 401, { error: "unauthorized", message: messages[check.reason] });
            return;
          }
        }

        await handleRecording(recordingId, request, response);
      } catch (error) {
        console.error("[playback] request failed:", error);
        if (!response.headersSent) {
          sendJson(response, 500, { error: "internal_error" });
        } else {
          response.end();
        }
      }
    })();
  });
}

/** Starts the proxy and resolves once it is listening. */
export async function startPlaybackServer(config: PlaybackConfig): Promise<Server> {
  const server = createPlaybackServer(config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bindAddress, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
