#!/usr/bin/env node
/**
 * Standalone auth smoke test: `npm run test:auth`.
 *
 * Exchanges the JWT for an access token, then makes one authenticated GET to
 * confirm the token is actually accepted. Prints scopes, never the token.
 */
import "dotenv/config";

import { getAccessToken, getTokenInfo, loadConfig, redact } from "../ringcentral/auth.js";

async function main(): Promise<void> {
  const config = loadConfig();

  console.log(`Server:    ${config.serverUrl}`);
  console.log(`Client ID: ${redact(config.clientId)}`);
  console.log(`JWT:       ${redact(config.jwt)}`);
  console.log("");

  console.log("Exchanging JWT for access token…");
  const token = await getAccessToken();
  const info = await getTokenInfo();
  console.log(`Token acquired (${info.tokenType}, expires ${info.expiresAt.toISOString()}).`);

  const url = `${config.serverUrl}/restapi/v1.0/account/~/extension/~`;
  console.log(`Calling GET ${url} …`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const raw = await response.text();

  if (!response.ok) {
    let detail = raw.slice(0, 500);
    try {
      const parsed = JSON.parse(raw) as { message?: string; errorCode?: string };
      if (parsed.message) {
        detail = parsed.errorCode ? `${parsed.errorCode}: ${parsed.message}` : parsed.message;
      }
    } catch {
      // Not JSON — keep the truncated body.
    }
    throw new Error(`Extension lookup failed (HTTP ${response.status}): ${detail}`);
  }

  const extension = JSON.parse(raw) as {
    id?: number;
    extensionNumber?: string;
    name?: string;
    type?: string;
  };

  console.log("");
  console.log("AUTH OK");
  console.log(`  Extension: ${extension.name ?? "?"} (#${extension.extensionNumber ?? "?"}, id ${extension.id ?? "?"}, type ${extension.type ?? "?"})`);
  console.log(`  Owner ID:  ${info.ownerId ?? "n/a"}`);
  console.log(`  Scopes (${info.scopes.length}):`);
  for (const scope of info.scopes.sort()) {
    console.log(`    - ${scope}`);
  }
}

main().catch((error: unknown) => {
  console.error("");
  console.error("AUTH FAILED");
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
