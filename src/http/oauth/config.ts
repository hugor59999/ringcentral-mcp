/**
 * OAuth configuration.
 *
 * OAuth is OPTIONAL. It switches on only when OAUTH_ISSUER_URL is set, so
 * local use over stdio and the existing static-token path are unaffected.
 */

export interface OAuthConfig {
  /** Public HTTPS base URL of this server — the OAuth issuer identifier. */
  issuerUrl: URL;
  /** Canonical URI of the MCP endpoint (RFC 8707 resource identifier). */
  resourceUrl: URL;
  /** Password the single configured user types on the consent screen. */
  userPassword: string;
  /** HMAC key for the stateless access/refresh tokens. */
  signingSecret: string;
  /** Where registered OAuth clients are persisted across restarts. */
  clientStorePath: string;
  accessTokenTtlSeconds: number;
}

export interface OAuthConfigResult {
  enabled: boolean;
  config?: OAuthConfig;
  /** Why OAuth is off, when it is. */
  reason?: string;
}

export function loadOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  mcpPath = "/mcp",
): OAuthConfigResult {
  const issuer = env.OAUTH_ISSUER_URL?.trim();
  if (!issuer) {
    return {
      enabled: false,
      reason:
        "OAUTH_ISSUER_URL is not set, so OAuth is disabled. The static " +
        "MCP_AUTH_TOKEN path still works.",
    };
  }

  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new Error(`OAUTH_ISSUER_URL is not a valid URL: "${issuer}".`);
  }

  // RFC 8414: the issuer identifier must have no query or fragment. A trailing
  // slash also breaks the string comparison clients perform against metadata.
  if (issuerUrl.search || issuerUrl.hash) {
    throw new Error("OAUTH_ISSUER_URL must have no query string or fragment.");
  }
  if (issuerUrl.pathname !== "/") {
    throw new Error(
      `OAUTH_ISSUER_URL must be an origin with no path, e.g. ` +
        `https://mcp.example.com — got "${issuer}".`,
    );
  }
  if (issuerUrl.protocol !== "https:" && issuerUrl.hostname !== "localhost") {
    throw new Error(
      "OAUTH_ISSUER_URL must use https (http is allowed only for localhost testing).",
    );
  }

  const userPassword = env.OAUTH_USER_PASSWORD?.trim();
  if (!userPassword) {
    throw new Error(
      "OAUTH_USER_PASSWORD is not set. It is the password entered on the " +
        "sign-in screen during the OAuth handshake, and OAuth cannot run " +
        "without it.",
    );
  }

  const signingSecret = env.OAUTH_SIGNING_SECRET?.trim();
  if (!signingSecret) {
    throw new Error(
      "OAUTH_SIGNING_SECRET is not set. It signs the issued access tokens.",
    );
  }

  const accessTokenTtlSeconds = Number(env.OAUTH_ACCESS_TOKEN_TTL_SECONDS ?? 3600);
  if (!Number.isInteger(accessTokenTtlSeconds) || accessTokenTtlSeconds < 60) {
    throw new Error(
      `OAUTH_ACCESS_TOKEN_TTL_SECONDS must be an integer of at least 60, got ` +
        `"${env.OAUTH_ACCESS_TOKEN_TTL_SECONDS}".`,
    );
  }

  // Normalised without a trailing slash, matching the canonical form clients
  // send in the RFC 8707 `resource` parameter.
  const resourceUrl = new URL(mcpPath, issuerUrl);

  return {
    enabled: true,
    config: {
      issuerUrl,
      resourceUrl,
      userPassword,
      signingSecret,
      clientStorePath: env.OAUTH_CLIENT_STORE_PATH?.trim() || "./data/oauth-clients.json",
      accessTokenTtlSeconds,
    },
  };
}
