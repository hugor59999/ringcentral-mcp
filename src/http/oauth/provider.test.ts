import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, mock } from "node:test";

import type { Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

import type { OAuthConfig } from "./config.js";
import { REPLAY_WINDOW_MS, SingleUserOAuthProvider, pkceChallenge } from "./provider.js";

/**
 * Covers the duplicate POST /token that ChatGPT sends seconds apart: the first
 * succeeds, and the second used to be rejected, which the client read as a
 * disconnection.
 */

const PASSWORD = "test-password";
const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const VERIFIER = "a".repeat(43);

const storeDirs: string[] = [];

function makeConfig(): OAuthConfig {
  const dir = mkdtempSync(join(tmpdir(), "ringcentral-mcp-oauth-test-"));
  storeDirs.push(dir);
  return {
    issuerUrl: new URL("https://mcp.example.test"),
    resourceUrl: new URL("https://mcp.example.test/mcp"),
    userPassword: PASSWORD,
    signingSecret: "s".repeat(64),
    clientStorePath: join(dir, "oauth-clients.json"),
    accessTokenTtlSeconds: 3600,
  };
}

function makeClient(id: string): OAuthClientInformationFull {
  return {
    client_id: id,
    redirect_uris: [REDIRECT_URI],
    client_name: `client-${id}`,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  } as OAuthClientInformationFull;
}

/** Minimal stand-in for the Express response the consent page is written to. */
function captureConsentPage(): { res: Response; html: () => string } {
  let html = "";
  const res = {
    status: () => res,
    set: () => res,
    send: (body: string) => {
      html = body;
      return res;
    },
  };
  return { res: res as unknown as Response, html: () => html };
}

/** Runs authorize + consent and returns the issued authorization code. */
async function issueCode(
  provider: SingleUserOAuthProvider,
  client: OAuthClientInformationFull,
  codeChallenge = pkceChallenge(VERIFIER),
): Promise<string> {
  const page = captureConsentPage();
  await provider.authorize(
    client,
    {
      redirectUri: REDIRECT_URI,
      codeChallenge,
      scopes: ["mcp"],
      state: "state-value",
      resource: new URL("https://mcp.example.test/mcp"),
    },
    page.res,
  );

  const loginId = /name="login_id" value="([a-f0-9]+)"/.exec(page.html())?.[1];
  assert.ok(loginId, "the consent page should carry a login_id");

  const result = provider.completeLogin(loginId, PASSWORD);
  assert.ok("redirectTo" in result, "the correct password should produce a redirect");

  const code = new URL(result.redirectTo).searchParams.get("code");
  assert.ok(code, "the redirect should carry an authorization code");
  return code;
}

/** The pair of calls the SDK's token handler makes, in order. */
async function exchange(
  provider: SingleUserOAuthProvider,
  client: OAuthClientInformationFull,
  code: string,
) {
  const challenge = await provider.challengeForAuthorizationCode(client, code);
  assert.equal(challenge, pkceChallenge(VERIFIER), "PKCE challenge must still be verifiable");
  return provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI);
}

after(() => {
  for (const dir of storeDirs) rmSync(dir, { recursive: true, force: true });
});

describe("duplicate authorization_code exchange", () => {
  it("returns the identical response when replayed inside the window", async () => {
    const provider = new SingleUserOAuthProvider(makeConfig());
    const client = makeClient("client-a");
    const code = await issueCode(provider, client);

    const first = await exchange(provider, client, code);
    const second = await exchange(provider, client, code);

    assert.deepEqual(second, first, "the duplicate must get byte-identical tokens");
    assert.equal(second.access_token, first.access_token);
    assert.equal(second.refresh_token, first.refresh_token);
  });

  it("rejects a replay once the window has passed", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });

    const provider = new SingleUserOAuthProvider(makeConfig());
    const client = makeClient("client-a");
    const code = await issueCode(provider, client);

    await exchange(provider, client, code);

    t.mock.timers.tick(REPLAY_WINDOW_MS + 1_000);

    await assert.rejects(
      () => provider.challengeForAuthorizationCode(client, code),
      /invalid, expired, or already used/,
      "a code replayed after the window must still be refused",
    );
    await assert.rejects(
      () => provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI),
      /invalid, expired, or already used/,
    );
  });

  it("never hands one client's tokens to another", async () => {
    const provider = new SingleUserOAuthProvider(makeConfig());
    const owner = makeClient("client-a");
    const other = makeClient("client-b");
    const code = await issueCode(provider, owner);

    await exchange(provider, owner, code);

    await assert.rejects(
      () => provider.exchangeAuthorizationCode(other, code, undefined, REDIRECT_URI),
      /invalid, expired, or already used/,
      "a different client must not receive the cached tokens",
    );
  });
});

describe("duplicate refresh_token exchange", () => {
  it("returns the identical response when replayed inside the window", async () => {
    const provider = new SingleUserOAuthProvider(makeConfig());
    const client = makeClient("client-a");
    const code = await issueCode(provider, client);

    const initial = await exchange(provider, client, code);
    assert.ok(initial.refresh_token);

    const first = await provider.exchangeRefreshToken(client, initial.refresh_token);
    const second = await provider.exchangeRefreshToken(client, initial.refresh_token);

    assert.deepEqual(second, first, "the duplicate refresh must get identical tokens");
    assert.equal(second.access_token, first.access_token);
  });

  it("still issues a fresh pair once the window has passed", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });

    const provider = new SingleUserOAuthProvider(makeConfig());
    const client = makeClient("client-a");
    const code = await issueCode(provider, client);
    const initial = await exchange(provider, client, code);

    const first = await provider.exchangeRefreshToken(client, initial.refresh_token!);

    t.mock.timers.tick(REPLAY_WINDOW_MS + 1_000);

    const later = await provider.exchangeRefreshToken(client, initial.refresh_token!);

    assert.notEqual(
      later.access_token,
      first.access_token,
      "outside the window a refresh must mint a new token, not replay the old one",
    );
    assert.equal(later.token_type, "Bearer");
  });

  it("rejects a tampered refresh token", async () => {
    const provider = new SingleUserOAuthProvider(makeConfig());
    const client = makeClient("client-a");

    await assert.rejects(
      () => provider.exchangeRefreshToken(client, "not.a.real.token"),
      /invalid or expired/,
    );
  });
});

// Keep the suite quiet: the provider logs every rejection by design.
mock.method(console, "error", () => {});
