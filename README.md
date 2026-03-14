# CopilotX

GitHub Copilot API proxy for OpenAI-compatible and Anthropic-compatible clients.

This repository is the Bun/Effect rewrite. It persists account state in PostgreSQL, proxies requests to the Copilot upstream API, and exposes both CLI and HTTP flows for account onboarding.

## What works today

- OpenAI-compatible endpoints:
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
- Anthropic-compatible endpoint:
  - `POST /v1/messages`
- Model listing:
  - `GET /v1/models`
- Health endpoints:
  - `GET /health`
  - `GET /readyz`
- CLI status:
  - `copilotx status`
  - `copilotx auth status`
- CLI login:
  - `copilotx auth login`
  - `copilotx auth login --token <github-token>`
- HTTP device login flow:
  - `POST /auth/device`
  - `POST /auth/device/poll`
- Local proxy usage accounting persisted in PostgreSQL
- Copilot quota reporting from GitHub
- Optional premium-request billing report lookup with a billing-capable GitHub token

## Requirements

- [Mise](https://mise.jdx.dev/) or Bun 1.3.10+
- PostgreSQL 17+
- A 32-byte token encryption key, encoded as either:
  - 64 hex characters, or
  - base64

## Local development with Mise

### 1. Install tools and dependencies

```bash
mise install
mise run install
```

### 2. Start PostgreSQL

```bash
mise run db-up
```

This starts the local database from `compose.yaml`:
- database: `copilotx_dev`
- user: `postgres`
- password: `postgres`
- port: `5432`

### 3. Configure environment

Copy `.env.example` to `.env` and set at least:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/copilotx_dev
COPILOTX_TOKEN_ENCRYPTION_KEY=<64-hex-chars>
```

Optional but recommended for remote access:

```bash
COPILOTX_API_KEY=<random-secret>
```

Optional billing token for premium-request billing reports:

```bash
COPILOTX_GITHUB_BILLING_TOKEN=<billing-capable-github-token>
```

### 4. Run migrations if you need CLI-only bootstrap

```bash
mise run db-migrate
```

The server now applies Drizzle migrations automatically on startup. This manual step is still useful if you want to run CLI commands that hit PostgreSQL before starting the server.

### 5. Authenticate an account

#### Device flow from the CLI

```bash
mise run auth-login
```

This prints:
- the GitHub verification URL
- the user code to enter in the browser
- polling progress until the account is imported

#### Import with an existing GitHub token

```bash
bun src/bin/cli.ts auth login --token <github-token>
```

#### Import legacy local state

If you already have `~/.copilotx/auth.json` from the older implementation:

```bash
bun run tools/import-legacy-account.ts
```

### 6. Start the server

```bash
mise run dev
```

Default local bind:
- host: `127.0.0.1`
- port: `24680`

### 7. Verify

```bash
curl http://127.0.0.1:24680/health
curl http://127.0.0.1:24680/readyz
curl http://127.0.0.1:24680/v1/models
bun src/bin/cli.ts status
```

## CLI commands

Currently implemented:

```bash
copilotx --version
copilotx serve [--host HOST] [--port PORT]
copilotx status
copilotx auth login [--token TOKEN]
copilotx auth status
copilotx models
```

`copilotx models` prints every discovered model from the runtime merge, including models that GitHub marks hidden from picker UI. The table includes a `Hidden` column so those models remain visible instead of being silently filtered out.

## HTTP endpoints

### Proxy endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/v1/chat/completions` | POST | OpenAI chat completions compatibility |
| `/v1/responses` | POST | OpenAI Responses API compatibility |
| `/v1/messages` | POST | Anthropic messages compatibility |
| `/v1/models` | GET | List merged available models |
| `/health` | GET | Process health |
| `/readyz` | GET | Server readiness for deployment and auth bootstrap |

### Auth bootstrap endpoints

These endpoints use the same device-flow logic as the CLI.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/auth/device` | POST | Start GitHub device authorization and return `device_code` + `user_code` |
| `/auth/device/poll` | POST | Poll device authorization using `device_code`; imports the account when authorized |

#### Start device authorization

```bash
curl -X POST http://127.0.0.1:24680/auth/device \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

Example response:

```json
{
  "object": "device_authorization",
  "status": "authorization_pending",
  "device_code": "0123456789abcdef...",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://github.com/login/device",
  "expires_in_seconds": 900,
  "interval_seconds": 5
}
```

#### Poll device authorization

```bash
curl -X POST http://127.0.0.1:24680/auth/device/poll \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"device_code":"0123456789abcdef..."}'
```

Possible responses:
- `202` with `status: authorization_pending`
- `202` with `status: slow_down`
- `200` with `status: authorized` and imported account details
- `403` with `status: access_denied`
- `410` with `status: expired_token`

## Authentication and readiness semantics

- `/readyz` now returns `200` as soon as the server is healthy enough to accept onboarding/auth requests.
- Before any Copilot account exists, the response body reports:
  - `authenticated: false`
  - `copilot_ready: false`
  - `status: "awaiting_authentication"`
- This is intentional so fresh deployments can come up and then receive their first account via CLI or HTTP auth flow.

## Environment variables

Minimum required:

```bash
DATABASE_URL=postgresql://...
COPILOTX_TOKEN_ENCRYPTION_KEY=<64-hex-or-base64>
```

Common runtime settings:

```bash
COPILOTX_HOST=127.0.0.1
COPILOTX_PORT=24680
COPILOTX_API_KEY=
COPILOTX_LOG_LEVEL=info
COPILOTX_TRUST_LOCALHOST=false
COPILOTX_GITHUB_BILLING_TOKEN=
```

## Deployment

### ZaneOps with Railpack

Railpack is the recommended deployment path for this rewrite.

Build directory:
- repository root

Install command:

```bash
bun install --frozen-lockfile
```

Build command:

```bash
bun run build
```

Start command:

```bash
bun dist/bin/server.js
```

Required environment variables in ZaneOps:

```bash
DATABASE_URL=postgresql://...
COPILOTX_TOKEN_ENCRYPTION_KEY=<64-hex-or-base64>
COPILOTX_API_KEY=<random-secret>
COPILOTX_HOST=0.0.0.0
COPILOTX_PORT=$PORT
```

Notes:
- `src/bin/server.ts` now reads host and port from config, so the packaged `dist/bin/server.js` is suitable for Railpack.
- Server startup now applies Drizzle migrations automatically before listening, so fresh deployments do not need a separate `bun run db:migrate` boot step.
- If you expose auth bootstrap endpoints publicly, keep `COPILOTX_API_KEY` set.

### Zerops

A starting `zerops.yaml` is included.

Current behavior:
- build base: `bun@latest`
- start command: `bun dist/bin/server.js`
- readiness check: `/readyz`

You still need to provide real secrets and service wiring in Zerops:

```bash
DATABASE_URL=postgresql://...
COPILOTX_TOKEN_ENCRYPTION_KEY=<64-hex-or-base64>
COPILOTX_API_KEY=<random-secret>
COPILOTX_HOST=0.0.0.0
COPILOTX_PORT=24680
```

Scaling guidance:
- Bun service: start with a single container, then scale vertically first.
- PostgreSQL: use Zerops vertical scaling; use HA mode for production if needed.
- Multi-container runtime deployment should be load-tested before relying on it for account rotation and rate-limit behavior.

### Docker

This rewrite does not yet include a first-class production Dockerfile. Railpack and Zerops are the current documented deployment paths.

## Quota and usage reporting

`copilotx status` reports:
- account health
- token validity
- model catalog refresh state
- GitHub Copilot plan and premium request quota
- optional GitHub premium-request billing report data
- local proxy-observed request and token counts persisted in PostgreSQL

What it does not report:
- global GitHub prompt/completion token totals across all Copilot surfaces

GitHub exposes request/quota and billing data, but not a truthful global prompt/completion token counter for end-user Copilot accounts.

## Disclaimer

Use this tool in compliance with GitHub Copilot terms and any organizational policy that applies to your account.

## License

MIT
