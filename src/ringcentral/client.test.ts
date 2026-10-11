import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { clearTokenCache } from "./auth.js";
import {
  RingCentralApiError,
  rcGet,
  resetThrottle,
  setMaxRequestsPerMinute,
} from "./client.js";

/**
 * Covers recovery from a rejected access token.
 *
 * RingCentral invalidates outstanding tokens when an app's permissions change,
 * and renewal here is otherwise purely time-based — so without this the server
 * keeps presenting a dead token for up to an hour, failing every call. Seen in
 * production on 2026-09-21: `401 [TokenInvalid] Token not found` on every tool
 * call.
 *
 * `fetch` is stubbed rather than the auth module, so the real token-exchange
 * path runs and we can watch it re-exchange.
 */

const API_PATH = "/restapi/v1.0/account/~/extension/~/call-log";

interface Recorded {
  tokenExchanges: number;
  apiCalls: string[];
}

let realFetch: typeof globalThis.fetch;

function stubFetch(apiResponder: (call: number, token: string) => Response): Recorded {
  const recorded: Recorded = { tokenExchanges: 0, apiCalls: [] };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes("/restapi/oauth/token")) {
      recorded.tokenExchanges++;
      return new Response(
        JSON.stringify({
          access_token: `token-${recorded.tokenExchanges}`,
          token_type: "bearer",
          expires_in: 3600,
          scope: "ReadCallLog",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    const token = auth.replace(/^Bearer\s+/, "");
    recorded.apiCalls.push(token);
    return apiResponder(recorded.apiCalls.length, token);
  }) as typeof fetch;

  return recorded;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ errorCode: "TokenInvalid", message: "Token not found" }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  clearTokenCache();
  resetThrottle();
  setMaxRequestsPerMinute(0); // no pacing, so the tests stay fast
  process.env.RINGCENTRAL_SERVER_URL = "https://platform.example.test";
  process.env.RINGCENTRAL_CLIENT_ID = "test-client-id";
  process.env.RINGCENTRAL_CLIENT_SECRET = "test-client-secret";
  process.env.RINGCENTRAL_JWT = "test-jwt";
  mock.method(console, "error", () => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearTokenCache();
  resetThrottle();
  setMaxRequestsPerMinute(8);
  mock.restoreAll();
});

describe("recovery from a rejected access token", () => {
  it("discards the cached token and retries once with a fresh one", async () => {
    const recorded = stubFetch((call) => (call === 1 ? unauthorized() : ok({ records: [] })));

    const result = await rcGet<{ records: unknown[] }>(API_PATH);

    assert.deepEqual(result, { records: [] }, "the retry should return the real payload");
    assert.equal(recorded.apiCalls.length, 2, "exactly one retry");
    assert.equal(recorded.tokenExchanges, 2, "the JWT must be exchanged again");
    assert.equal(recorded.apiCalls[0], "token-1");
    assert.equal(recorded.apiCalls[1], "token-2", "the retry must use the new token");
  });

  it("gives up after a single retry when the fresh token is refused too", async () => {
    const recorded = stubFetch(() => unauthorized());

    await assert.rejects(
      () => rcGet(API_PATH),
      (error: unknown) => {
        assert.ok(error instanceof RingCentralApiError);
        assert.equal(error.status, 401);
        assert.equal(error.errorCode, "TokenInvalid");
        return true;
      },
      "a genuinely invalid credential must surface, not loop",
    );

    assert.equal(recorded.apiCalls.length, 2, "one attempt plus one retry, no more");
  });

  it("does not re-exchange the token on a non-auth failure", async () => {
    const recorded = stubFetch(() =>
      new Response(JSON.stringify({ errorCode: "CMN-102", message: "Not found" }), {
        status: 404,
      }),
    );

    await assert.rejects(() => rcGet(API_PATH), /HTTP 404/);

    assert.equal(recorded.apiCalls.length, 1, "a 404 is not retried");
    assert.equal(recorded.tokenExchanges, 1, "and the token is left alone");
  });

  it("logs every non-2xx with status, error code and path, and no secret", async () => {
    mock.restoreAll();
    const lines: string[] = [];
    mock.method(console, "error", (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    stubFetch((call) => (call === 1 ? unauthorized() : ok({ records: [] })));
    await rcGet(API_PATH);

    const failure = lines.find((l) => l.includes("HTTP 401"));
    assert.ok(failure, "the 401 must be logged");
    assert.match(failure, /TokenInvalid/, "with the RingCentral error code");
    assert.match(failure, /call-log/, "and the path");

    const all = lines.join("\n");
    for (const secret of ["test-jwt", "test-client-secret", "token-1", "token-2"]) {
      assert.ok(!all.includes(secret), `logs must not contain ${secret}`);
    }
  });
});
