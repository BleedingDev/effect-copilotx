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

### 4. Configure coding agents (optional but recommended)

> Example remote setup uses a placeholder URL. Replace it with your own deployed CopilotX domain.

> If you want to use a hosted proxy from coding agents, pass the deployed URL and your normal proxy API key.

> The CLI can now configure Claude Code, Codex CLI, Factory Droid, and Oh My Pi in one step.

```bash
copilotx config all \
  --base-url https://your-domain.example \
  --api-key YOUR_PROXY_API_KEY
```

That command configures:
- Claude Code via `~/.claude/settings.json`
- Codex CLI via `~/.codex/config.toml` plus `~/.copilotx/bin/codex-copilotx`
- Factory Droid via `~/.factory/settings.local.json` plus `~/.copilotx/bin/droid-copilotx`
- Oh My Pi via `~/.copilotx/bin/omp-copilotx`

> Add launchers to your shell once:

> `export PATH="$HOME/.copilotx/bin:$PATH"`

> Individual targets are also supported: `claude-code`, `codex-cli`, `factory-droid`, `oh-my-pi`.

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
mise run start                    # start Postgres + proxy
mise run stop                     # stop Postgres
mise run auth-login               # device-flow login
mise run auth-logout              # remove persisted accounts
mise run status                   # auth/quota/account status
mise run models                   # list all models, including hidden ones
copilotx config claude-code       # wire Claude Code to local or remote CopilotX
copilotx config codex-cli         # wire OpenAI Codex CLI to CopilotX
copilotx config factory-droid     # wire Factory Droid to CopilotX
copilotx config oh-my-pi          # create Oh My Pi launcher against CopilotX
copilotx config all               # configure all supported agent CLIs at once
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

### Import an existing GitHub token (admin-only)

```bash
curl -X POST https://your-domain.example/auth/import-github-token \
  -H 'Authorization: Bearer YOUR_IMPORT_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"github_token":"ghu_..."}'
```

## Using the deployed proxy from coding agents

### Claude Code

After `copilotx config claude-code --base-url ... --api-key ...`:
- launch `claude` normally
- requests go to CopilotX through the configured Anthropic-compatible endpoint
- model defaults come from the generated Claude env block

### Codex CLI

After `copilotx config codex-cli --base-url ... --api-key ...`:
- run `codex-copilotx`
- the launcher uses the generated `copilotx` profile in `~/.codex/config.toml`
- Codex talks to CopilotX through the OpenAI Responses API

### Factory Droid

After `copilotx config factory-droid --base-url ... --api-key ...`:
- run `droid-copilotx` for interactive mode
- run `droid-copilotx exec \"your prompt\"` for automation
- the launcher selects the generated `custom-model` entry in `~/.factory/settings.local.json`

### Oh My Pi

After `copilotx config oh-my-pi --base-url ... --api-key ...`:
- run `omp-copilotx`
- the launcher exports `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and Oh My Pi role model env vars before launching `omp`

### Verify the deployment first

```bash
curl https://your-domain.example/readyz
curl -H 'Authorization: Bearer YOUR_PROXY_API_KEY' \
  https://your-domain.example/v1/models
```

Expected readiness after account import:
- `authenticated: true`
- `accounts_healthy: 15`
- `copilot_ready: true`


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
COPILOTX_API_KEY=<normal-client-secret>
COPILOTX_IMPORT_API_KEY=<admin-only-import-secret>
COPILOTX_HOST=0.0.0.0
COPILOTX_PORT=$PORT
```

### Zerops

`zerops.yaml` is included.

The same required env vars apply:

```bash
DATABASE_URL=postgresql://...
COPILOTX_TOKEN_ENCRYPTION_KEY=<64-hex-or-base64>
COPILOTX_API_KEY=<normal-client-secret>
COPILOTX_IMPORT_API_KEY=<admin-only-import-secret>
COPILOTX_HOST=0.0.0.0
COPILOTX_PORT=24680
```

## Truthful limits

- No first-class production Dockerfile yet
- HTTP auth API covers device-flow bootstrap and admin token import; keep `COPILOTX_IMPORT_API_KEY` admin-only
- GitHub still does not expose truthful global prompt/completion token totals for end-user Copilot accounts
