# KampusPing WhatsApp gateway

Node service that owns the WhatsApp session for KampusPing (tuition billing reminders) and
exposes a small HTTP API to the backend worker. It is the `GatewayProvider` side of the
backend's `WhatsAppProvider` (`kampusping-backend/app/modules/whatsapp/gateway.py`).

```text
Backend worker ──HTTP (Bearer key)──► gateway (127.0.0.1:8095) ──Baileys──► WhatsApp
Backend API ◄──webhook (HMAC-signed)── gateway: delivery receipts, connection changes
```

> **Warning: unofficial WhatsApp client.** The gateway uses [Baileys](https://github.com/WhiskeySockets/Baileys),
> an unofficial WhatsApp Web library. This violates the WhatsApp terms of service and deviates
> from the BRD recommendation (official Cloud API); see `docs/adr/0002-baileys-whatsapp-gateway.md`
> in the workspace root. The number can be **banned, possibly permanently**, and Baileys can
> break whenever WhatsApp changes its protocol. The Baileys maintainers themselves discourage
> bulk or automated messaging. Use a **dedicated number** (never the main campus number) and keep
> the backend safeguards on: random delay between messages, daily cap, send window, opt-out,
> automatic pause on disconnect or repeated failures.

## Stack and pinned versions

| Package                                 | Version                                   | Why this one                                                                                                                                                                                                                     |
| --------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@whiskeysockets/baileys`               | `6.7.24`                                  | Latest **stable** release (dist-tag `legacy`, 2026-07-29). The `latest` dist-tag points at `7.0.0-rc14`, a release candidate; v7 is not used until it is final. Upgrading means re-reading the typings used in `src/baileys.ts`. |
| `fastify`                               | `5.12.7`                                  | HTTP server (latest).                                                                                                                                                                                                            |
| `pino`                                  | `9.14.0`                                  | Logger; the same major as Baileys and Fastify use, so one copy is installed.                                                                                                                                                     |
| TypeScript / Vitest / ESLint / Prettier | `5.9.3` / `4.1.12` / `10.14.0` / `3.9.10` | Dev tooling. Vitest 4 (not 5) and `@types/node` 20 because the runtime target is Node 20+.                                                                                                                                       |

All versions are exact (no `^`). Notes on Baileys 6.7.24:

- It depends on `libsignal` straight from GitHub (`whiskeysockets/libsignal-node`, pinned to a
  commit in `package-lock.json`). The lockfile records a `git+ssh` URL, but npm downloads public
  GitHub dependencies as an HTTPS tarball, so `npm ci` works without SSH keys (checked) as long as
  github.com is reachable. `libsignal` is **GPL-3.0** licensed.
- At startup it asks GitHub (`raw.githubusercontent.com`) for the current WhatsApp Web version
  (`fetchLatestBaileysVersion`, 5 s timeout) and falls back to the bundled version when that
  fails. If pairing keeps failing with "Connection Failure" (405), update Baileys.

Node 20 or newer (`process.loadEnvFile`, used for `.env`, needs Node 20.12+; on older Node set the
variables in the environment).

## HTTP API

Every route, unknown routes included, requires `Authorization: Bearer <WA_GATEWAY_API_KEY>`
(constant-time comparison); otherwise `401 {"error":"unauthorized"}`. The server listens on a
loopback address only.

| Route            | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /messages` | Body `{"to":"+628...","text":"...","client_ref":"msg-123"}`. `200 {"provider_message_id":"..."}`; `404 {"error":"not_on_whatsapp"}`; `503 {"error":"disconnected"}` when the session is not connected; `400 {"error":"invalid_request"}` when `to` is not `^\+\d{8,15}$`, `text` is blank or over 4096 characters, `client_ref` is empty or over 100 characters, or the body is not a JSON object; `500 {"error":"internal"}` for anything unexpected (the backend retries). |
| `GET /status`    | `200 {"state":"connected"\|"connecting"\|"qr"\|"disconnected","qr":<string\|null>}`                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /logout`   | Unlinks the device, wipes `WA_AUTH_DIR` and starts over, so `GET /status` soon shows a new QR. `200 {"status":"ok"}`.                                                                                                                                                                                                                                                                                                                                                        |

### Exactly-once sending per `client_ref`

The worker retries a send when it did not get (or could not record) an answer. The gateway keeps a
durable store `client_ref -> {provider_message_id, sent_at}` in `WA_DEDUPE_FILE` (JSON, rewritten
atomically: temp file, fsync, rename), retained `WA_DEDUPE_TTL_DAYS` (default and minimum 14) and
pruned on start and hourly.

- A repeated `client_ref` answers `200` with the **original** id and sends nothing, even while
  disconnected.
- Concurrent requests with the same `client_ref` share one attempt (single-flight).
- Only successful sends are recorded; a failed attempt can be retried.
- The record is written right after WhatsApp accepted the message and before the answer. If the
  process dies in that window (milliseconds), the ref is lost and a later retry sends again:
  at-least-once in that window, exactly-once otherwise. If the write fails (disk full), the send
  still answers `200` and the ref is remembered in memory until the next restart (logged as an
  error).
- A missing store starts empty; an unreadable one starts empty with a warning and is kept as
  `<file>.corrupt`.

## Webhook to the backend

`POST <WA_WEBHOOK_URL>` with `Content-Type: application/json` and
`X-Signature: sha256=<lowercase hex HMAC-SHA256 of the exact body bytes, key WA_WEBHOOK_SECRET>`.

```json
{"type":"status","provider_message_id":"3EB0...","state":"delivered"}
{"type":"connection","state":"connected"}
```

`status.state` is `delivered`, `read` or `failed`; `connection.state` is one of the four states of
`GET /status` (sent when it changes, not on every QR refresh).

- **Receipts are delayed.** The backend only knows a `provider_message_id` after its worker
  committed the send, and it answers `202` and drops receipts for unknown ids (it cannot ask for
  them again). So a receipt is sent no earlier than `WA_STATUS_DELAY_MS` (default 2 s) after the
  answer to the send that produced the id. If the same `client_ref` is asked again (the worker lost
  the first answer), the latest receipt is sent once more after the delay.
- **Retries.** Network errors, timeouts and every non-2xx answer (redirects are not followed) are
  retried `WA_WEBHOOK_RETRIES` times (default 5) with exponential backoff from
  `WA_WEBHOOK_RETRY_BASE_MS` (1 s, 2 s, 4 s, 8 s, 16 s). The same signed bytes are resent.
- **Ordering.** Events of one message are delivered strictly in order (`read` never overtakes
  `delivered`); one message's retries do not hold up the others.
- The queue is **in memory**: events still queued when the process stops are lost, and an event
  that fails every retry is dropped with a warning (no payload logged).

## Configuration

Copy `.env.example` to `.env` (the gateway reads `.env` from its working directory; real
environment variables win). Startup fails with a clear list of problems when something is wrong.

| Variable                     | Default                 | Notes                                                                                         |
| ---------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `GATEWAY_HOST`               | `127.0.0.1`             | Must be `127.0.0.1`, `::1` or `localhost` unless `GATEWAY_ALLOW_NON_LOOPBACK=true`.           |
| `GATEWAY_PORT`               | `8095`                  |                                                                                               |
| `GATEWAY_ALLOW_NON_LOOPBACK` | `false`                 | Only for setups where the network is otherwise protected (containers).                        |
| `WA_GATEWAY_API_KEY`         | (required)              | At least 16 characters; same value as the backend's `WA_GATEWAY_API_KEY`.                     |
| `WA_WEBHOOK_URL`             | (required)              | http(s) URL of the backend webhook, e.g. `http://127.0.0.1:8093/api/v1/webhooks/whatsapp`.    |
| `WA_WEBHOOK_SECRET`          | (required)              | At least 16 characters; same value as the backend's `WA_WEBHOOK_SECRET`.                      |
| `WA_WEBHOOK_RETRIES`         | `5`                     | Retries after the first attempt (1-10).                                                       |
| `WA_WEBHOOK_RETRY_BASE_MS`   | `1000`                  | First retry delay; doubles on every retry.                                                    |
| `WA_WEBHOOK_TIMEOUT_MS`      | `10000`                 | Per attempt.                                                                                  |
| `WA_STATUS_DELAY_MS`         | `2000`                  | Minimum delay between a send answer and its receipts (500-60000).                             |
| `WA_AUTH_DIR`                | `./auth_state`          | Baileys session (credentials).                                                                |
| `WA_DEDUPE_FILE`             | `./data/sent-refs.json` | `client_ref` store.                                                                           |
| `WA_DEDUPE_TTL_DAYS`         | `14`                    | 14-365.                                                                                       |
| `LOG_LEVEL`                  | `info`                  | Gateway log level.                                                                            |
| `WA_BAILEYS_LOG_LEVEL`       | `warn`                  | Baileys log level: `silent`, `fatal`, `error`, `warn` or `info` (verbose levels log content). |

Generate secrets with e.g. `openssl rand -hex 32`.

## Pairing (QR code)

1. Start the gateway. With no session in `WA_AUTH_DIR`, the state becomes `qr` and `GET /status`
   returns the pairing string in `qr` (a new one every ~20 s).
2. Show it as a QR code: the backend relays it in `GET /api/v1/whatsapp/status` for the
   KampusPing settings page (WhatsApp section). Without the UI, fetch it on the server itself:
   `curl -s -H "Authorization: Bearer $WA_GATEWAY_API_KEY" http://127.0.0.1:8095/status` and
   render the `qr` string with any QR tool (it is the raw string, not an image).
3. On the dedicated phone: WhatsApp > Linked devices > Link a device, scan the code. The state
   goes `connecting` then `connected` (a restart requested by WhatsApp right after pairing is
   handled automatically).

To switch numbers or re-pair, use the disconnect action in the UI (`POST /logout`). If the device
is unlinked from the phone, the gateway stays `disconnected` (it does not reconnect after a
logout) until `POST /logout` is called, which wipes the old session and shows a new QR.

## Data on disk: protect and back up

| Path          | Content                                       | If lost                                                     |
| ------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `auth_state/` | WhatsApp session keys (equivalent to a login) | Pair again by QR. If copied, someone else can send as you.  |
| `data/`       | `client_ref` dedupe store                     | Retries of recent messages may send duplicates for 14 days. |

- Both are in `.gitignore`; never commit them and keep them out of any web root.
- Owned by the PM2 user, mode `700` (the gateway creates `auth_state/` with `0700` and files
  in `data/` with `0600`): `chmod -R go-rwx auth_state data`.
- Back both up together (e.g. nightly, stop not required), encrypted, with the same care as other
  secrets. Restoring `auth_state/` brings back the session without a new QR, unless WhatsApp has
  unlinked the device meanwhile.
- Baileys documents `useMultiFileAuthState` (used here) as a reference store rather than one for
  heavy production use; at one number and a few hundred messages a day it is adequate. Keep the
  path configurable (`WA_AUTH_DIR`) on a local disk, not a network share.

## Development

| Task                  | Command                                                     |
| --------------------- | ----------------------------------------------------------- |
| Install               | `npm install`                                               |
| Run (watch)           | `npm run dev` (needs `.env`; listens on `127.0.0.1:8095`)   |
| Test                  | `npm test`                                                  |
| Lint / types / format | `npm run lint`, `npm run typecheck`, `npm run format:check` |
| Quality gate          | `npm run check` (all of the above)                          |
| Build                 | `npm run build` (to `dist/`)                                |
| Start built           | `npm start`                                                 |

For backend development without a phone, set `WA_PROVIDER=fake` in the backend instead of running
the gateway. Only `src/baileys.ts` imports Baileys; everything else is tested with a fake
`WaClient`, a fake `fetch` and a manual clock. The socket wiring itself can only be verified with a
real phone (manual smoke test before each release that touches the gateway).

## Production (PM2)

The PM2 app is `kampusping-wa-gateway`, **one instance** (a WhatsApp session cannot be shared),
`max_memory_restart: 512M`, listening on `127.0.0.1:8095` only. There is no Nginx site for it.

```bash
cp .env.example .env   # fill in real values (same key/secret as the backend)
bash deploy/deploy-prod.sh   # npm ci, build, (re)start PM2, check that /status answers 401
```

`deploy/ecosystem.prod.config.js` is CommonJS (`deploy/package.json` sets `"type": "commonjs"`
because the project itself is ESM). Stopping the process closes the socket and gives queued
webhooks up to 5 s.

## Privacy

Phone numbers are personal data (UU PDP). Logs never contain message text, full phone numbers
(only the last four digits), the API key or the webhook secret; request bodies are not logged and
errors are logged by type and code only. Baileys' own log lines pass through a filter that masks
phone-like numbers and drops message content, contact names and key material. Inbound messages
are not handled yet (milestone M3) and are never logged.

## License

MIT, see `LICENSE`. Note that Baileys' dependency `libsignal` is GPL-3.0.
