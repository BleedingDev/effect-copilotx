# effect-copilotx

Effect/Bun rewrite of CopilotX.

It runs a local GitHub Copilot proxy with:
- OpenAI-compatible endpoints
- Anthropic-compatible endpoint
- CLI login/status/models
- HTTP device auth bootstrap endpoints
- PostgreSQL-backed account state and usage counters

## Dead simple local start

### 1. Install Bun via Mise

```bash
mise install
```

### 2. Start everything

```bash
mise run start
```

That one command will:
- install Bun dependencies if needed
- create `.env` from `.env.example` if missing
- generate `COPILOTX_TOKEN_ENCRYPTION_KEY` if blank
- start PostgreSQL 18 with Docker Compose, or reuse an existing database already reachable at `DATABASE_URL`
- wait for PostgreSQL to be ready
- auto-apply Drizzle migrations
- start the proxy and write its actual address to `~/.copilotx/server.json`

### 3. Login to GitHub Copilot

In another terminal:

```bash
mise run auth-login
```

### 4. Configure Claude Code (optional)

```bash
mise run config-claude-code
```

That command reads `~/.copilotx/server.json`, so it still points Claude Code at the right local URL when `24680` was busy and the proxy moved.

For a remote CopilotX deployment, use the raw CLI command instead:

```bash
copilotx config claude-code --base-url https://your-domain.example --api-key YOUR_API_KEY
```

### 5. Use it

The running local URL is always written to `~/.copilotx/server.json`.

If `24680` was free, the default local base URLs are:

OpenAI-compatible base URL:

```text
http://127.0.0.1:24680/v1
```

Anthropic-compatible base URL:

```text
http://127.0.0.1:24680
```

## The only commands most people need

```bash
mise run start              # start Postgres + proxy
mise run stop               # stop Postgres
mise run auth-login         # device-flow login
mise run auth-logout        # remove persisted accounts
mise run config-claude-code # write Claude Code settings
mise run status             # auth/quota/account status
mise run models             # list all models, including hidden ones
```

## Useful URLs

- Health: `GET /health`
- Readiness: `GET /readyz`
- Models: `GET /v1/models`
- OpenAI chat: `POST /v1/chat/completions`
- OpenAI responses: `POST /v1/responses`
- Anthropic messages: `POST /v1/messages`

## Auth bootstrap API

If you want to onboard accounts through HTTP instead of the CLI:

### Start device flow

```bash
curl -X POST http://127.0.0.1:24680/auth/device \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

### Poll device flow

```bash
curl -X POST http://127.0.0.1:24680/auth/device/poll \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"device_code":"..."}'
```

## Notes that matter

- Minimum supported database: PostgreSQL 18+
- Server startup auto-runs migrations
- `copilotx serve` auto-picks a portless-compatible free port when `24680` is busy
- the actual running proxy URL is always written to `~/.copilotx/server.json`
- if you already use global `portless`, `PORT`, `HOST`, and `PORTLESS_URL` are honored automatically
- `mise run models` shows all discovered models, including models GitHub marks hidden
- `/readyz` returns `200` before first login so fresh deployments can bootstrap auth

## Deployment

### ZaneOps Railpack

Use:
- Install: `bun install --frozen-lockfile`
- Build: `bun run build`
- Start: `bun dist/bin/server.js`

Required env:

```bash
DATABASE_URL=postgresql://...
COPILOTX_TOKEN_ENCRYPTION_KEY=<64-hex-or-base64>
COPILOTX_API_KEY=<random-secret>
COPILOTX_HOST=0.0.0.0
COPILOTX_PORT=$PORT
```

### Zerops

`zerops.yaml` is included.

The same required env vars apply:

```bash
DATABASE_URL=postgresql://...
COPILOTX_TOKEN_ENCRYPTION_KEY=<64-hex-or-base64>
COPILOTX_API_KEY=<random-secret>
COPILOTX_HOST=0.0.0.0
COPILOTX_PORT=24680
```

## Truthful limits

- No first-class production Dockerfile yet
- HTTP auth API currently covers device-flow bootstrap only
- GitHub still does not expose truthful global prompt/completion token totals for end-user Copilot accounts
