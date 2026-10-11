import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Response } from "express";

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import type { OAuthConfig } from "./config.js";

/**
 * A minimal but standards-correct OAuth 2.1 authorization server for a
 * single-tenant MCP deployment.
 *
 * Design notes:
 *
 *  - **Tokens are stateless.** An access token is a signed payload, verified by
 *    HMAC rather than looked up, so tokens survive a restart and nothing has to
 *    be stored or expired server-side.
 *  - **Registered clients are persisted** to a small JSON file. A restart would
 *    otherwise invalidate the connector's registration and force the user
 *    through the consent screen again.
 *  - **Authorization codes are in memory** with a five-minute lifetime. They
 *    are exchanged within seconds, so losing them on restart is harmless.
 *  - **One user.** There is no user database: the consent screen takes a single
 *    configured password. That is appropriate for one practice's server, and is
 *    the whole of the "who are you" question.
 */

export const MCP_SCOPE = "mcp";

const AUTH_CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;

/**
 * How long a successful token exchange stays replayable.
 *
 * ChatGPT's infrastructure sometimes sends the same POST /token twice, seconds
 * apart, from different hosts. The second request would hit a consumed
 * authorization code and get `400 invalid_grant`, which the client reads as a
 * broken connection and turns into a reconnect prompt for the user.
 *
 * Inside this window a duplicate exchange returns the *same* response as the
 * first, rather than an error. Replay safety is preserved by three things: the
 * duplicate must come from the same client, PKCE is still verified against the
 * original challenge (so a stolen code without the verifier still fails), and
 * the window is short.
 *
 * Note this deliberately softens the OAuth 2.1 advice to treat a reused code as
 * an attack. The trade is a 60-second window against a connector that breaks in
 * normal use; every replay is logged so genuine abuse stays visible.
 */
export const REPLAY_WINDOW_MS = 60_000;

interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

/** A token response kept briefly so a duplicate request gets the same answer. */
interface ReplayEntry {
  clientId: string;
  tokens: OAuthTokens;
  /** Set for authorization codes, so PKCE can still be checked on a replay. */
  codeChallenge?: string;
  expiresAt: number;
}

interface PendingAuthorization {
  clientId: string;
  clientName?: string;
  params: AuthorizationParams;
  expiresAt: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Escapes text for safe interpolation into the consent page. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

class FileClientStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  constructor(private readonly path: string) {
    this.load();
    this.checkWritable();
  }

  /**
   * Reports at startup whether registrations can actually be saved.
   *
   * Without this the first sign that the store is unwritable is an EACCES when
   * a client registers — by which point the connector appears to work and only
   * breaks later, after a restart, as "invalid_client".
   */
  private checkWritable(): void {
    const directory = dirname(this.path);
    try {
      mkdirSync(directory, { recursive: true });
      accessSync(directory, constants.W_OK);
      console.error(`[oauth] client store is writable: ${this.path}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[oauth] WARNING: cannot write to ${directory} (${reason}).\n` +
          `[oauth] Clients will register successfully but be forgotten on ` +
          `restart, so the connector will need reconnecting and may report ` +
          `"invalid_client".\n` +
          `[oauth] In Docker this means the volume mounted there is not ` +
          `writable by the container user — see README.md.`,
      );
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as OAuthClientInformationFull[];
      for (const client of parsed) this.clients.set(client.client_id, client);
      console.error(`[oauth] loaded ${this.clients.size} registered client(s)`);
    } catch {
      // No store yet — the first registration creates it.
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify([...this.clients.values()], null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      // A read-only filesystem must not break the handshake; the registration
      // simply will not survive a restart.
      console.error(
        `[oauth] could not persist registered clients to ${this.path}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Registration will be lost on restart.`,
      );
    }
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(registered.client_id, registered);
    this.persist();
    console.error(
      `[oauth] registered client ${registered.client_id} ` +
        `(${registered.client_name ?? "unnamed"})`,
    );
    return registered;
  }
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: FileClientStore;

  private readonly codes = new Map<string, StoredCode>();
  private readonly pending = new Map<string, PendingAuthorization>();
  /** Keyed by a keyed hash of the code or refresh token — never the value. */
  private readonly replays = new Map<string, ReplayEntry>();

  constructor(private readonly config: OAuthConfig) {
    this.clientsStore = new FileClientStore(config.clientStorePath);
  }

  // --- idempotency ---------------------------------------------------------

  /**
   * Derives the replay-cache key. The secret itself is never stored: the key is
   * an HMAC of it under the server's signing secret, so the cache cannot leak a
   * code or refresh token even if its contents were dumped.
   */
  private replayKey(kind: "code" | "refresh", secret: string): string {
    return createHmac("sha256", this.config.signingSecret)
      .update(`${kind}:${secret}`)
      .digest("hex");
  }

  private rememberForReplay(
    key: string,
    clientId: string,
    tokens: OAuthTokens,
    codeChallenge?: string,
  ): void {
    this.replays.set(key, {
      clientId,
      tokens,
      codeChallenge,
      expiresAt: Date.now() + REPLAY_WINDOW_MS,
    });
  }

  /** Returns a live replay entry for this client, if one exists. */
  private replayFor(key: string, clientId: string): ReplayEntry | undefined {
    const entry = this.replays.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.replays.delete(key);
      return undefined;
    }
    // A different client must never receive another client's tokens.
    if (entry.clientId !== clientId) return undefined;
    return entry;
  }

  /** Logs a rejected token request. Carries no code, token or verifier. */
  private logTokenFailure(grantType: string, reason: string, clientId?: string): void {
    console.error(
      `[oauth] /token rejected: grant_type=${grantType} error=invalid_grant ` +
        `reason="${reason}"` +
        (clientId ? ` client=${clientId.slice(0, 8)}` : ""),
    );
  }

  // --- token minting / verification ---------------------------------------

  private sign(payload: string): string {
    return createHmac("sha256", this.config.signingSecret).update(payload).digest("base64url");
  }

  private mintToken(
    type: "access" | "refresh",
    clientId: string,
    scopes: string[],
    ttlSeconds: number,
    resource?: string,
  ): string {
    const body = base64url(
      JSON.stringify({
        t: type,
        cid: clientId,
        scp: scopes,
        aud: resource ?? this.config.resourceUrl.href,
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
        jti: randomBytes(8).toString("hex"),
      }),
    );
    return `${body}.${this.sign(body)}`;
  }

  private readToken(
    token: string,
    expectedType: "access" | "refresh",
  ): { clientId: string; scopes: string[]; audience: string; expiresAt: number } {
    const [body, signature] = token.split(".");
    if (!body || !signature) throw new InvalidTokenError("Malformed token");
    if (!constantTimeEquals(signature, this.sign(body))) {
      throw new InvalidTokenError("Invalid token signature");
    }

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      t: string;
      cid: string;
      scp: string[];
      aud: string;
      exp: number;
    };

    if (payload.t !== expectedType) throw new InvalidTokenError("Wrong token type");
    if (payload.exp * 1000 <= Date.now()) throw new InvalidTokenError("Token expired");

    return {
      clientId: payload.cid,
      scopes: payload.scp ?? [],
      audience: payload.aud,
      expiresAt: payload.exp,
    };
  }

  // --- authorization ------------------------------------------------------

  /**
   * Renders the consent screen. The SDK's /authorize handler has already
   * validated the client, redirect URI and PKCE challenge by this point.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.sweep();

    const loginId = randomBytes(24).toString("hex");
    this.pending.set(loginId, {
      clientId: client.client_id,
      clientName: client.client_name,
      params,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    const name = escapeHtml(client.client_name ?? "An application");
    res
      .status(200)
      .set("Content-Type", "text/html; charset=utf-8")
      .set("Cache-Control", "no-store")
      .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize access</title>
<style>
 body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f7f9;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;color:#1a1a1a}
 .card{background:#fff;padding:2rem;border-radius:12px;max-width:26rem;width:100%;
       box-shadow:0 1px 3px rgba(0,0,0,.1)}
 h1{font-size:1.25rem;margin:0 0 .5rem} p{margin:.5rem 0;color:#444}
 ul{color:#444;padding-left:1.2rem} label{display:block;margin:1.25rem 0 .35rem;font-weight:600}
 input{width:100%;padding:.6rem;font-size:1rem;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
 button{margin-top:1.25rem;width:100%;padding:.7rem;font-size:1rem;font-weight:600;color:#fff;
        background:#1a56db;border:0;border-radius:6px;cursor:pointer}
 .err{background:#fee;border:1px solid #fbb;color:#900;padding:.6rem;border-radius:6px;margin-bottom:1rem}
</style></head><body><div class="card">
<h1>Authorize access</h1>
<p><strong>${name}</strong> is asking to connect to your RingCentral phone tools.</p>
<p>If you approve, it will be able to:</p>
<ul><li>read call history, missed calls and recordings</li>
<li>see who is waiting for a callback</li></ul>
<p>Sending messages and deleting records stay disabled unless separately enabled on the server.</p>
<form method="POST" action="/oauth/login">
  <input type="hidden" name="login_id" value="${loginId}">
  <label for="password">Server password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Approve access</button>
</form>
</div></body></html>`);
  }

  /**
   * Completes the consent step: checks the password, issues a code, and
   * redirects back to the client. Returns the redirect URL, or an error to
   * re-render.
   */
  completeLogin(loginId: string, password: string): { redirectTo: string } | { error: string } {
    this.sweep();

    const record = this.pending.get(loginId);
    if (!record) {
      return { error: "This sign-in request has expired. Start the connection again." };
    }

    if (!constantTimeEquals(password, this.config.userPassword)) {
      return { error: "Incorrect password." };
    }

    this.pending.delete(loginId);

    const code = randomBytes(32).toString("hex");
    this.codes.set(code, {
      clientId: record.clientId,
      redirectUri: record.params.redirectUri,
      codeChallenge: record.params.codeChallenge,
      scopes: record.params.scopes ?? [MCP_SCOPE],
      resource: record.params.resource?.href,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    const redirect = new URL(record.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (record.params.state !== undefined) {
      redirect.searchParams.set("state", record.params.state);
    }
    // RFC 9207. This MUST be byte-identical to the `issuer` in the
    // authorization-server metadata — clients compare the two with simple
    // string comparison and reject the response on any difference, including
    // a trailing slash.
    redirect.searchParams.set("iss", this.config.issuerUrl.href);

    return { redirectTo: redirect.href };
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (record) {
      if (record.clientId !== client.client_id) {
        this.logTokenFailure(
          "authorization_code",
          "code belongs to a different client",
          client.client_id,
        );
        throw new InvalidGrantError("Authorization code is invalid, expired, or already used");
      }
      return record.codeChallenge;
    }

    // Not live. It may be a duplicate request replaying a code consumed moments
    // ago — hand back the original challenge so the SDK still verifies PKCE
    // against it, rather than failing before the exchange is even attempted.
    const replay = this.replayFor(this.replayKey("code", authorizationCode), client.client_id);
    if (replay?.codeChallenge) {
      return replay.codeChallenge;
    }

    this.logTokenFailure(
      "authorization_code",
      "code unknown, expired, or already used outside the replay window",
      client.client_id,
    );
    throw new InvalidGrantError("Authorization code is invalid, expired, or already used");
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.sweep();

    const key = this.replayKey("code", authorizationCode);
    const record = this.codes.get(authorizationCode);

    if (!record) {
      // Duplicate of an exchange that just succeeded: answer identically.
      const replay = this.replayFor(key, client.client_id);
      if (replay) {
        console.error(
          `[oauth] /token: duplicate authorization_code exchange within ` +
            `${REPLAY_WINDOW_MS / 1000}s — returning the original response ` +
            `(client=${client.client_id.slice(0, 8)})`,
        );
        return replay.tokens;
      }

      this.logTokenFailure(
        "authorization_code",
        "code unknown, expired, or already used outside the replay window",
        client.client_id,
      );
      throw new InvalidGrantError("Authorization code is invalid, expired, or already used");
    }

    if (record.clientId !== client.client_id) {
      this.logTokenFailure(
        "authorization_code",
        "code belongs to a different client",
        client.client_id,
      );
      throw new InvalidGrantError("Authorization code is invalid, expired, or already used");
    }

    // Single use, always — even if the rest of this fails.
    this.codes.delete(authorizationCode);

    if (record.expiresAt <= Date.now()) {
      this.logTokenFailure("authorization_code", "code expired", client.client_id);
      throw new InvalidGrantError("Authorization code has expired");
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      this.logTokenFailure("authorization_code", "redirect_uri mismatch", client.client_id);
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }

    const audience = resource?.href ?? record.resource ?? this.config.resourceUrl.href;

    const tokens: OAuthTokens = {
      access_token: this.mintToken(
        "access",
        client.client_id,
        record.scopes,
        this.config.accessTokenTtlSeconds,
        audience,
      ),
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      scope: record.scopes.join(" "),
      refresh_token: this.mintToken(
        "refresh",
        client.client_id,
        record.scopes,
        30 * 24 * 3600,
        audience,
      ),
    };

    this.rememberForReplay(key, client.client_id, tokens, record.codeChallenge);
    return tokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.sweep();

    const key = this.replayKey("refresh", refreshToken);

    // A duplicate refresh would otherwise mint a second, different token pair,
    // leaving the client unsure which one is current.
    const replay = this.replayFor(key, client.client_id);
    if (replay) {
      console.error(
        `[oauth] /token: duplicate refresh_token exchange within ` +
          `${REPLAY_WINDOW_MS / 1000}s — returning the original response ` +
          `(client=${client.client_id.slice(0, 8)})`,
      );
      return replay.tokens;
    }

    let payload;
    try {
      payload = this.readToken(refreshToken, "refresh");
    } catch (error) {
      this.logTokenFailure(
        "refresh_token",
        error instanceof Error ? error.message : "unreadable token",
        client.client_id,
      );
      throw new InvalidGrantError("Refresh token is invalid or expired");
    }
    if (payload.clientId !== client.client_id) {
      this.logTokenFailure(
        "refresh_token",
        "token issued to a different client",
        client.client_id,
      );
      throw new InvalidGrantError("Refresh token was issued to a different client");
    }

    const granted = scopes?.length ? scopes : payload.scopes;
    const audience = resource?.href ?? payload.audience;

    const tokens: OAuthTokens = {
      access_token: this.mintToken(
        "access",
        client.client_id,
        granted,
        this.config.accessTokenTtlSeconds,
        audience,
      ),
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      scope: granted.join(" "),
      refresh_token: this.mintToken("refresh", client.client_id, granted, 30 * 24 * 3600, audience),
    };

    this.rememberForReplay(key, client.client_id, tokens);
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = this.readToken(token, "access");
    return {
      token,
      clientId: payload.clientId,
      scopes: payload.scopes,
      expiresAt: payload.expiresAt,
      resource: new URL(payload.audience),
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    _request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // Tokens are stateless and short-lived, so there is no store to remove
    // them from. Accepting the request without error is the correct response:
    // RFC 7009 requires a 200 for tokens the server cannot act on.
  }

  /** Drops expired codes and pending sign-ins. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(key);
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
    for (const [key, value] of this.replays) if (value.expiresAt <= now) this.replays.delete(key);
  }
}

/** Computes the PKCE S256 challenge for a verifier. Used by the tests. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
