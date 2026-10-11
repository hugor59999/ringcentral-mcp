import "dotenv/config";

/**
 * RingCentral server-to-server auth.
 *
 * Exchanges a long-lived JWT credential for a short-lived access token using
 * the `jwt-bearer` grant, and keeps that token cached in memory until it is
 * close to expiry.
 *
 * Nothing in this module ever logs a credential or a token in full — use
 * `redact()` if you need to reference one in an error message.
 */

const REFRESH_MARGIN_MS = 60_000;

export interface RingCentralConfig {
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  jwt: string;
}

/** Non-sensitive metadata about the cached token. Never carries the token. */
export interface TokenInfo {
  scopes: string[];
  tokenType: string;
  ownerId?: string;
  expiresAt: Date;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  owner_id?: string;
}

interface CachedToken {
  accessToken: string;
  tokenType: string;
  scopes: string[];
  ownerId?: string;
  /** Epoch ms at which the token should be considered stale. */
  refreshAt: number;
  expiresAt: number;
}

let cached: CachedToken | null = null;
/** De-dupes concurrent refreshes so we only ever have one exchange in flight. */
let inFlight: Promise<CachedToken> | null = null;

/** Masks a secret for safe inclusion in logs: `dWd1…lI (22 chars)`. */
export function redact(value: string | undefined): string {
  if (!value) return "<unset>";
  if (value.length <= 8) return `<${value.length} chars>`;
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RingCentralConfig {
  const required = {
    RINGCENTRAL_SERVER_URL: env.RINGCENTRAL_SERVER_URL,
    RINGCENTRAL_CLIENT_ID: env.RINGCENTRAL_CLIENT_ID,
    RINGCENTRAL_CLIENT_SECRET: env.RINGCENTRAL_CLIENT_SECRET,
    RINGCENTRAL_JWT: env.RINGCENTRAL_JWT,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value || value.trim() === "")
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Copy .env.example to .env and fill them in.`,
    );
  }

  return {
    serverUrl: required.RINGCENTRAL_SERVER_URL!.replace(/\/+$/, ""),
    clientId: required.RINGCENTRAL_CLIENT_ID!,
    clientSecret: required.RINGCENTRAL_CLIENT_SECRET!,
    jwt: required.RINGCENTRAL_JWT!,
  };
}

async function exchangeJwtForToken(config: RingCentralConfig): Promise<CachedToken> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: config.jwt,
  });

  const response = await fetch(`${config.serverUrl}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const raw = await response.text();

  if (!response.ok) {
    // RingCentral returns {error, error_description} — safe to surface, it
    // describes the failure without echoing the assertion back.
    let detail = raw.slice(0, 500);
    try {
      const parsed = JSON.parse(raw) as { error?: string; error_description?: string };
      if (parsed.error) {
        detail = parsed.error_description
          ? `${parsed.error}: ${parsed.error_description}`
          : parsed.error;
      }
    } catch {
      // Not JSON — keep the truncated body.
    }
    throw new Error(
      `JWT token exchange failed (HTTP ${response.status}): ${detail} ` +
        `[client_id=${redact(config.clientId)}, jwt=${redact(config.jwt)}]`,
    );
  }

  const data = JSON.parse(raw) as TokenResponse;

  if (!data.access_token) {
    throw new Error("JWT token exchange succeeded but returned no access_token.");
  }

  const now = Date.now();
  const lifetimeMs = (data.expires_in ?? 3600) * 1000;

  return {
    accessToken: data.access_token,
    tokenType: data.token_type ?? "Bearer",
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : [],
    ownerId: data.owner_id,
    expiresAt: now + lifetimeMs,
    // Refresh a minute early, but never schedule a refresh in the past.
    refreshAt: now + Math.max(lifetimeMs - REFRESH_MARGIN_MS, lifetimeMs / 2),
  };
}

async function ensureToken(): Promise<CachedToken> {
  if (cached && Date.now() < cached.refreshAt) {
    return cached;
  }

  if (!inFlight) {
    const config = loadConfig();
    inFlight = exchangeJwtForToken(config)
      .then((token) => {
        cached = token;
        return token;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

/** Returns a valid access token, exchanging or refreshing the JWT as needed. */
export async function getAccessToken(): Promise<string> {
  return (await ensureToken()).accessToken;
}

/** Returns non-sensitive metadata about the current token. */
export async function getTokenInfo(): Promise<TokenInfo> {
  const token = await ensureToken();
  return {
    scopes: token.scopes,
    tokenType: token.tokenType,
    ownerId: token.ownerId,
    expiresAt: new Date(token.expiresAt),
  };
}

/** Drops the cached token; the next call re-exchanges the JWT. */
export function clearTokenCache(): void {
  cached = null;
}
