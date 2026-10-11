# RingCentral MCP

An [MCP](https://modelcontextprotocol.io) server that gives an AI assistant
controlled access to a RingCentral account: call history, recordings,
voicemail, SMS threads, missed-call follow-ups, and — behind several safety
switches — sending text and picture messages.

It speaks MCP over **stdio** (for clients that launch it locally, such as
Claude Desktop or Claude Code) and over **HTTP** (for hosted assistants), and
runs a small **playback proxy** that streams call recordings without ever
exposing a RingCentral credential to the listener.

## Tools

| Tool | What it does | Scope needed |
| --- | --- | --- |
| `get_call_history` | Call-log entries involving a phone number: direction, parties, start time, duration, outcome, and whether a recording exists. | ReadCallLog |
| `get_call_recording` | Metadata and a short-lived signed playback URL for one recording. | ReadCallRecording |
| `search_by_phone_number` | One chronological timeline of all contact with a number (calls, plus SMS and voicemail once enabled). | ReadCallLog (+ ReadMessages) |
| `find_missed_calls` | Inbound calls nobody answered, optionally including those that reached voicemail. | ReadCallLog |
| `detect_followups` | Callers who were not answered and never got a call back, grouped per caller, most overdue first. | ReadCallLog |
| `get_voicemail` | Voicemail messages with caller, timestamp, duration, transcription and attachment reference. | ReadMessages |
| `get_sms_conversation` | The SMS thread with one number, oldest first, with delivery status. | ReadMessages |
| `get_message_status` | Delivery state of one message, explained in plain language. | ReadMessages |
| `send_sms` | Send a text message — preview first, then explicit confirmation. | SMS |
| `send_mms` | Send a picture/media message — preview first, then explicit confirmation. | SMS |
| `delete_call_log_entry` | Delete one call-log entry by id — disabled by default, preview first. | EditCallLog |

When a date range is omitted, RingCentral defaults to roughly the last 24 hours.

## Safeguards

- **Sending is off by default.** Unless `ALLOW_REAL_SENDS=true` (exactly the
  word `true`, any case), `send_sms` and `send_mms` validate everything and
  return the request they *would* send, without contacting RingCentral. Any
  other value — `1`, `yes`, a typo — counts as off.
- **Preview, then confirm.** A send without `confirm: true` only returns a
  preview (recipient, sending number, full text, attachments). The assistant is
  instructed to show it and wait for explicit approval before calling again
  with identical arguments and `confirm: true`.
- **Duplicate protection.** An identical message to the same recipient within
  `DUPLICATE_SEND_WINDOW_SECONDS` (default 600) is refused. The comparison
  ignores case and extra whitespace and does not depend on the sending number.
- **Sender verification.** The `from` number (or `DEFAULT_SMS_FROM`) must be
  one of the account's SMS-enabled numbers; anything else is refused.
- **Deletion is off by default.** `delete_call_log_entry` only shows what would
  be deleted unless `ALLOW_DELETIONS=true`, and even then requires confirmation
  for a single call id. Lists and bulk deletion are rejected.
- **Rate limiting.** Requests to RingCentral are paced to
  `RC_MAX_REQUESTS_PER_MINUTE` (default 8) to stay under RingCentral's limits
  and avoid its 60-second penalty.
- **No arguments in logs.** Tool failures are logged by name and message only;
  arguments — phone numbers, message bodies — are never written to the logs.
- **Recordings are never stored.** Audio is streamed straight through the
  playback proxy with `Cache-Control: no-store`; nothing is written to disk.
  Playback links are HMAC-signed and expire (default 15 minutes).

## Installation

Requirements: Node.js 18+ (22 recommended) and a RingCentral app using the
JWT auth flow.

```bash
git clone https://github.com/hugor59999/ringcentral-mcp.git
cd ringcentral-mcp
npm ci
cp .env.example .env   # then fill in the values
npm run build
```

### Configuration

Every variable is documented in [`.env.example`](.env.example). The essentials:

| Variable | Purpose |
| --- | --- |
| `RINGCENTRAL_SERVER_URL` | `https://platform.ringcentral.com` (or the sandbox host) |
| `RINGCENTRAL_CLIENT_ID` / `RINGCENTRAL_CLIENT_SECRET` | From the RingCentral Developer Console, *your app > Credentials* |
| `RINGCENTRAL_JWT` | Server-to-server JWT credential (*Console > Credentials > JWT*) |
| `MCP_AUTH_TOKEN` | Bearer token for the HTTP MCP endpoint (self-generated) |
| `PLAYBACK_AUTH_TOKEN`, `SIGNING_SECRET`, `PLAYBACK_BASE_URL` | Playback proxy |
| `OAUTH_ISSUER_URL`, `OAUTH_USER_PASSWORD`, `OAUTH_SIGNING_SECRET` | Optional OAuth 2.1 for hosted clients that only support OAuth |
| `ALLOW_REAL_SENDS`, `ALLOW_DELETIONS` | Safety switches, both `false` by default |

Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`.env` is git-ignored — never commit it. Rotate the JWT and client secret in
the Developer Console if they are ever exposed.

### Checks

```bash
npm run typecheck
npm test              # unit tests, no network access
npm run test:auth     # verifies the RingCentral credentials
npm run test:tool -- +15555550100   # read-only smoke test of every tool
```

`test:tool` never sends a message or deletes anything.

## Usage with Claude

### Claude Desktop

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ringcentral": {
      "command": "node",
      "args": ["/absolute/path/to/ringcentral-mcp/dist/index.js"]
    }
  }
}
```

The server loads `.env` from its working directory; alternatively pass the
variables in an `"env"` block.

### Claude Code

```bash
claude mcp add ringcentral -- node /absolute/path/to/ringcentral-mcp/dist/index.js
```

### Remote (HTTP)

Hosted clients connect to `https://<your-host>/mcp` with
`Authorization: Bearer <MCP_AUTH_TOKEN>`, or through OAuth when
`OAUTH_ISSUER_URL` is set.

Example prompts:

- "Who called us yesterday and didn't get a call back?"
- "Show me everything we have with +1 555 555 0100 this month."
- "Draft a text to +1 555 555 0100 saying their booking is confirmed for Tuesday" —
  the assistant shows the preview and sends only after you approve.

## Docker deployment

```bash
cp .env.example .env   # fill it in
docker compose up -d --build ringcentral-mcp
docker compose logs -f ringcentral-mcp
```

The compose file:

- publishes the playback proxy (8787) and MCP endpoint (8788) on
  **127.0.0.1 only** — put an HTTPS reverse proxy in front;
- runs with a read-only root filesystem, `no-new-privileges`, and as the
  unprivileged `node` user;
- keeps a single volume for the OAuth client store (`/app/data`);
- sets `TRUST_PROXY_HOPS=1` for one reverse proxy.

### Reverse proxy (nginx)

Terminate TLS in nginx and forward to the loopback ports, for example:

```nginx
server {
    listen 443 ssl;
    server_name mcp.your-domain.com;
    # ssl_certificate ... ;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}

server {
    listen 443 ssl;
    server_name recordings.your-domain.com;
    # ssl_certificate ... ;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
    }
}
```

Set `PLAYBACK_BASE_URL=https://recordings.your-domain.com` and, if using OAuth,
`OAUTH_ISSUER_URL=https://mcp.your-domain.com`. Never drop the `127.0.0.1:`
prefix from the port mappings.

## Project layout

```
src/
├── index.ts              Entry point: stdio, MCP over HTTP, playback proxy
├── mcp-server.ts         Registers the 11 tools
├── http/
│   ├── mcp-http.ts       Streamable HTTP MCP endpoint and bearer auth
│   ├── playback.ts       Recording playback proxy
│   ├── signing.ts        HMAC-signed playback links
│   └── oauth/            Minimal OAuth 2.1 authorization server
├── ringcentral/
│   ├── auth.ts           JWT authentication and token refresh
│   ├── client.ts         API client with rate limiting
│   ├── call-log.ts       Call-log helpers
│   ├── messages.ts       Message-store helpers
│   └── outbound.ts       SMS/MMS sending, guards and duplicate detection
├── timeline/             Providers merged by search_by_phone_number
├── tools/                One file per MCP tool
└── scripts/              test-auth and test-tool smoke tests
```

Tests live next to the code they cover (`*.test.ts`) and run with
`npm test`.

## License

Unlicensed — all rights reserved.
