# Deploying the WhatsApp gateway

Production layout: PM2 runs `dist/index.js` on `127.0.0.1:8095`. There is **no Nginx site and no
public route** for it; only the backend on the same host calls it.

```bash
cp .env.example .env     # set WA_GATEWAY_API_KEY, WA_WEBHOOK_SECRET (same values as the backend's)
                         # and WA_WEBHOOK_URL=http://127.0.0.1:8093/api/v1/webhooks/whatsapp
chmod +x deploy/*.sh
bash deploy/deploy-prod.sh   # npm ci, build, (re)start PM2, check that /status answers 401
```

The gateway refuses to start with empty, short (under 16 characters) or `change-me...` secrets.
Protect `auth_state/` (the WhatsApp login) like a password and back it up; see
`docs/runbook-whatsapp.md` in the workspace root.

## Deploy order

Roll the four processes out in this order:

1. **Migrate** the database (backend repo, `--migrate`).
2. **API** (`kampusping-backend`, 127.0.0.1:8093).
3. **Worker** (`kampusping-worker`, same backend deploy).
4. **Gateway** (`kampusping-wa-gateway`, this repo).
5. **Web** (`kampusping-frontend`, 127.0.0.1:8094).

**Never run two workers** (backend repo), and never run two gateways on the same WhatsApp session:
the Baileys session cannot be shared, so the PM2 config has exactly one instance in fork mode.

Prefer containers? See the workspace root `docker-compose.yml` (`--profile whatsapp`) and the
`Dockerfile` in this repo.
