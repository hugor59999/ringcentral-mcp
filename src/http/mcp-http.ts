import type { Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

import express, { type NextFunction, type Request, type Response } from "express";

import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createMcpServer } from "../mcp-server.js";
import { loadOAuthConfig } from "./oauth/config.js";
import { MCP_SCOPE, SingleUserOAuthProvider } from "./oauth/provider.js";

/**
 * MCP over HTTP, with two ways to authenticate:
 *
 *  - **A static bearer token** (`MCP_AUTH_TOKEN`) — simple, and what curl and
 *    scripted clients use. Unchanged.
 *  - **OAuth 2.1** — what ChatGPT's custom connectors require, since their UI
 *    offers no static-token option. Added alongside, never replacing.
 *
 * Either satisfies a request. OAuth switches on only when OAUTH_ISSUER_URL is
 * set, so nothing changes for existing setups.
 *
 * This listener is plain HTTP and must sit behind an HTTPS reverse proxy — see
 * README.md.
 */

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** At most this many method names are listed for a batched request. */
const MAX_BATCH_METHODS_LOGGED = 5;

export interface RpcDescription {
  /** JSON-RPC method, or undefined when the body could not be read. */
  method?: string;
  /** Tool name for a tools/call, and nothing else from params. */
  tool?: string;
}

/**
 * Summarises a JSON-RPC body for the request log.
 *
 * Deliberately narrow: it reads `method` and, for a `tools/call`, `params.name`
 * — nothing more. Tool arguments are never touched, because they carry the
 * things that must not reach a log file: a customer's phone number, the body of
 * a text message, a recording id. Anything unreadable yields no method rather
 * than an error, since logging must never be able to fail a request.
 */
export function describeRpc(body: unknown): RpcDescription {
  if (Array.isArray(body)) {
    const methods = body
      .map((entry) => (entry as { method?: unknown } | null)?.method)
      .filter((m): m is string => typeof m === "string");

    if (methods.length === 0) return {};
    const shown = methods.slice(0, MAX_BATCH_METHODS_LOGGED).join(",");
    const extra = methods.length > MAX_BATCH_METHODS_LOGGED ? ",…" : "";
    return { method: `batch[${shown}${extra}]` };
  }

  if (typeof body !== "object" || body === null) return {};

  const { method, params } = body as { method?: unknown; params?: unknown };
  if (typeof method !== "string") return {};

  if (method === "tools/call" && typeof params === "object" && params !== null) {
    const name = (params as { name?: unknown }).name;
    if (typeof name === "string") return { method, tool: name };
  }

  return { method };
}

export interface McpHttpConfig {
  authToken: string;
  port: number;
  path: string;
  bindAddress: string;
  /**
   * How many reverse proxies sit in front of this server. 0 = none.
   *
   * Express uses this to decide how much of `X-Forwarded-For` to believe when
   * working out the client's IP. It must be a hop count, never `true`:
   * blanket trust lets a caller forge the header and defeat rate limiting,
   * and express-rate-limit rejects it outright (ERR_ERL_PERMISSIVE_TRUST_PROXY).
   */
  trustProxyHops: number;
}

export function loadMcpHttpConfig(env: NodeJS.ProcessEnv = process.env): McpHttpConfig {
  const authToken = env.MCP_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error(
      "MCP_AUTH_TOKEN is not set. The HTTP MCP endpoint refuses to start " +
        "without it — an unauthenticated endpoint would expose the whole " +
        "RingCentral account.",
    );
  }

  const port = Number(env.MCP_PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MCP_PORT must be a valid port number, got "${env.MCP_PORT}".`);
  }

  const rawPath = env.MCP_PATH?.trim() || "/mcp";
  const path = rawPath.startsWith("/") ? rawPath.replace(/\/+$/, "") || "/" : `/${rawPath}`;

  /**
   * Loopback by default, so a bare `npm start` never exposes the tools.
   *
   * Inside Docker this MUST be 0.0.0.0: the published-port proxy connects to
   * the container's eth0 address, so a process bound to the container's
   * loopback is unreachable and every request is refused. Confinement there
   * comes from the `127.0.0.1:PORT:PORT` host mapping instead.
   */
  const bindAddress = env.MCP_BIND_ADDRESS?.trim() || "127.0.0.1";

  /**
   * Defaults to 0 — no proxy — so running directly cannot be tricked by a
   * forged X-Forwarded-For. Behind the nginx setup in README.md this must
   * be 1; docker-compose.yml sets it.
   */
  const rawHops = env.TRUST_PROXY_HOPS?.trim();
  const trustProxyHops = rawHops === undefined || rawHops === "" ? 0 : Number(rawHops);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 10) {
    throw new Error(
      `TRUST_PROXY_HOPS must be a whole number between 0 and 10 — the number ` +
        `of reverse proxies in front of this server — got "${rawHops}". ` +
        `Use 0 for none and 1 for a single nginx. It must not be "true": ` +
        `blanket trust would let a caller forge X-Forwarded-For.`,
    );
  }

  return { authToken, port, path, bindAddress, trustProxyHops };
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerFrom(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  return /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
}

export interface CreatedMcpApp {
  app: express.Express;
  oauthEnabled: boolean;
  oauthReason?: string;
  issuerUrl?: URL;
}

export function createMcpHttpApp(config: McpHttpConfig): CreatedMcpApp {
  const app = express();
  app.disable("x-powered-by");

  /**
   * Tell Express exactly how many proxy hops to trust.
   *
   * Without this, nginx sets X-Forwarded-For, Express ignores it, and
   * express-rate-limit — which the SDK's auth router applies to the OAuth
   * endpoints — throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR from its key
   * generator, so the request never completes and ChatGPT gets no tools.
   *
   * A hop count rather than `true`: with `true` Express would believe the
   * left-most, caller-supplied entry, letting anyone forge an IP and evade
   * the limiter. express-rate-limit refuses that configuration by design.
   */
  app.set("trust proxy", config.trustProxyHops);

  const oauth = loadOAuthConfig(process.env, config.path);
  const provider = oauth.enabled ? new SingleUserOAuthProvider(oauth.config!) : undefined;

  let resourceMetadataUrl: string | undefined;

  if (oauth.enabled && provider) {
    const { issuerUrl, resourceUrl } = oauth.config!;
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);

    // The consent form posts here. Registered before the SDK router so it is
    // never shadowed.
    app.post(
      "/oauth/login",
      express.urlencoded({ extended: false }),
      (request: Request, response: Response) => {
        const { login_id: loginId, password } = request.body as Record<string, string>;
        const result = provider.completeLogin(loginId ?? "", password ?? "");

        if ("error" in result) {
          response
            .status(401)
            .set("Content-Type", "text/html; charset=utf-8")
            .send(
              `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>` +
                `<body style="font:16px system-ui;padding:2rem"><h1>Sign-in failed</h1>` +
                `<p>${result.error}</p><p><a href="javascript:history.back()">Go back</a></p></body>`,
            );
          return;
        }
        response.redirect(302, result.redirectTo);
      },
    );

    /**
     * Logs every rejected /token request.
     *
     * The provider logs the failures it raises itself, but rejections coming
     * from the SDK's handler — unsupported grant_type, unknown client, PKCE
     * mismatch, malformed body — would otherwise be invisible, which is what
     * made the duplicate-exchange problem so hard to see. Registered before the
     * SDK router so it wraps the response.
     *
     * Never logs the code, refresh token or verifier.
     */
    app.use(
      "/token",
      express.urlencoded({ extended: false }),
      (request: Request, response: Response, next: NextFunction) => {
        const grantType =
          (request.body as Record<string, string> | undefined)?.grant_type ?? "(absent)";

        const sendJson = response.json.bind(response);
        response.json = (body: unknown) => {
          if (response.statusCode >= 400) {
            const error = body as { error?: string; error_description?: string } | undefined;
            console.error(
              `[oauth] /token failed: grant_type=${grantType} ` +
                `status=${response.statusCode} error=${error?.error ?? "unknown"} ` +
                `reason="${error?.error_description ?? ""}"`,
            );
          }
          return sendJson(body);
        };

        next();
      },
    );

    // We emit the RFC 9207 `iss` parameter on authorization responses, so the
    // metadata MUST advertise it. The SDK's document omits the field, so serve
    // our own copy first — registered before the SDK router, which makes this
    // handler win for this path.
    const asMetadataWithIss = {
      ...createOAuthMetadata({
        provider,
        issuerUrl,
        baseUrl: issuerUrl,
        scopesSupported: [MCP_SCOPE],
      }),
      authorization_response_iss_parameter_supported: true,
    };
    app.get("/.well-known/oauth-authorization-server", (_request, response) => {
      response.set("Cache-Control", "no-store").json(asMetadataWithIss);
    });

    // Authorization-server + protected-resource metadata, /authorize, /token,
    // /register (Dynamic Client Registration) and /revoke.
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        baseUrl: issuerUrl,
        resourceServerUrl: resourceUrl,
        resourceName: "RingCentral MCP server",
        scopesSupported: [MCP_SCOPE],
      }),
    );

    // The SDK serves protected-resource metadata at the path-specific URL. The
    // spec has clients fall back to the root, and some probe it first, so
    // serve it there too.
    const metadata = {
      resource: resourceUrl.href,
      // Byte-identical to the `issuer` advertised by the authorization-server
      // metadata, so the client's string comparison succeeds.
      authorization_servers: [issuerUrl.href],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "RingCentral MCP server",
    };
    app.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.set("Cache-Control", "no-store").json(metadata);
    });

    // OpenID Connect discovery is the documented fallback when a client cannot
    // use RFC 8414. Serving the same document keeps strict clients happy.
    app.get("/.well-known/openid-configuration", (_request, response) => {
      response.set("Cache-Control", "no-store").json(asMetadataWithIss);
    });
  }

  /** Accepts either the static token or a valid OAuth access token. */
  const authenticate = async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    const presented = bearerFrom(request);

    if (presented && tokenMatches(presented, config.authToken)) {
      response.locals.mcpAuth = "static";
      next();
      return;
    }

    if (presented && provider) {
      try {
        const info = await provider.verifyAccessToken(presented);
        (request as Request & { auth?: unknown }).auth = info;
        // Client id only — never the token itself.
        response.locals.mcpAuth = `oauth:${info.clientId.slice(0, 8)}`;
        next();
        return;
      } catch {
        // Fall through to the challenge below.
      }
    }

    // RFC 9728: point the client at the metadata that starts the OAuth flow.
    const challenge = resourceMetadataUrl
      ? `Bearer resource_metadata="${resourceMetadataUrl}", scope="${MCP_SCOPE}"`
      : 'Bearer realm="mcp"';

    response
      .status(401)
      .set("WWW-Authenticate", challenge)
      .json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: provider
            ? "Unauthorized. Authorize via OAuth, or send the static MCP token as a bearer token."
            : "Unauthorized. Provide the MCP token as: Authorization: Bearer <MCP_AUTH_TOKEN>",
        },
        id: null,
      });
  };

  /**
   * One line per request reaching the MCP endpoint.
   *
   * Runs before authentication so refused requests are logged too, and reads
   * what it can once the body has been parsed further down the chain. Four
   * separate incidents were diagnosed through nginx because the server itself
   * kept no record of what it had been asked to do.
   */
  const logRequest = (request: Request, response: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();

    response.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const rpc = (response.locals.mcpRpc ?? {}) as RpcDescription;

      console.error(
        `[mcp] ${request.method} ${rpc.method ?? "-"}` +
          `${rpc.tool ? ` ${rpc.tool}` : ""}` +
          ` -> ${response.statusCode} in ${Math.round(ms)}ms` +
          ` (${(response.locals.mcpAuth as string | undefined) ?? "unauthenticated"})`,
      );
    });

    next();
  };

  app.all(
    config.path,
    logRequest,
    authenticate,
    express.json({ limit: MAX_BODY_BYTES }),
    (request: Request, response: Response, next: NextFunction) => {
      // Never let a logging problem break the call it is describing.
      try {
        response.locals.mcpRpc = describeRpc(request.body);
      } catch {
        response.locals.mcpRpc = {};
      }
      next();
    },
    async (request: Request, response: Response) => {
      // Stateless: a fresh server and transport per request, so no state leaks
      // between callers and a crashed request cannot poison the next.
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      response.on("close", () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    },
  );

  app.use((_request, response) => {
    response.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32601, message: `Unknown path. The MCP endpoint is ${config.path}.` },
      id: null,
    });
  });

  // Express 5 needs an explicit error handler with all four parameters.
  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
    console.error("[mcp-http] request failed:", error);
    if (!response.headersSent) {
      response
        .status(500)
        .json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    } else {
      response.end();
    }
  });

  return {
    app,
    oauthEnabled: oauth.enabled,
    oauthReason: oauth.reason,
    issuerUrl: oauth.config?.issuerUrl,
  };
}

/** Starts the MCP HTTP listener and resolves once it is accepting connections. */
export async function startMcpHttpServer(
  config: McpHttpConfig,
): Promise<{ server: Server; oauthEnabled: boolean; oauthReason?: string; issuerUrl?: URL }> {
  const created = createMcpHttpApp(config);

  const server = await new Promise<Server>((resolve, reject) => {
    const listener = created.app.listen(config.port, config.bindAddress, () => {
      listener.off("error", reject);
      resolve(listener);
    });
    listener.once("error", reject);
  });

  return {
    server,
    oauthEnabled: created.oauthEnabled,
    oauthReason: created.oauthReason,
    issuerUrl: created.issuerUrl,
  };
}
