#!/usr/bin/env node
import "dotenv/config";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadMcpHttpConfig, startMcpHttpServer } from "./http/mcp-http.js";
import { loadPlaybackConfig, startPlaybackServer } from "./http/playback.js";
import { createMcpServer } from "./mcp-server.js";

/**
 * Startup.
 *
 * Three surfaces run side by side:
 *   - stdio            the MCP transport for locally launched clients
 *   - MCP over HTTP    the MCP transport for hosted clients
 *   - playback proxy   recording audio streaming
 *
 * The two HTTP listeners are optional: if either fails to start, the server
 * says so on stderr and carries on, so a misconfigured port never costs you
 * the transports that do work.
 *
 * stdout belongs to the stdio MCP framing — nothing may be written there.
 */

async function startPlayback(): Promise<void> {
  try {
    const config = loadPlaybackConfig();
    await startPlaybackServer(config);
    console.error(
      `ringcentral-mcp playback proxy listening on ` +
        `${config.bindAddress}:${config.port} (base URL ${config.baseUrl})`,
    );
  } catch (error) {
    console.error(
      `ringcentral-mcp playback proxy NOT started: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function startMcpHttp(): Promise<void> {
  try {
    const config = loadMcpHttpConfig();
    const started = await startMcpHttpServer(config);
    console.error(
      `ringcentral-mcp MCP HTTP endpoint listening on ` +
        `${config.bindAddress}:${config.port}${config.path} (bearer auth required)`,
    );
    if (started.oauthEnabled) {
      console.error(
        `ringcentral-mcp OAuth enabled — issuer ${started.issuerUrl?.href.replace(/\/$/, "")}`,
      );
    } else {
      console.error(`ringcentral-mcp OAuth disabled — ${started.oauthReason}`);
    }
  } catch (error) {
    console.error(
      `ringcentral-mcp MCP HTTP endpoint NOT started: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function main(): Promise<void> {
  await startPlayback();
  await startMcpHttp();

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ringcentral-mcp running on stdio");
}

main().catch((error) => {
  console.error("Fatal error starting ringcentral-mcp:", error);
  process.exit(1);
});
