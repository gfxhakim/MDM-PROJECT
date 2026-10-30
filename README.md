# MDM Express — Onboarding + Account Management

One web app with two role-scoped consoles on a shared support-platform core. See `CLAUDE.md` for the
rules the build follows and `docs/` for the two specifications.

## Run it locally

```bash
npm install
cp .env.example .env          # DATABASE_URL (SQLite in dev) and JWT_SECRET
npx prisma db push
npm run db:seed               # configuration v1, the team, templates, macros
npm run db:demo               # optional: demo merchants and sellers (dev databases only)
npm run dev                   # http://localhost:3000
```

Sign in at `/` with any seeded account (dev password `mdm-dev-2026`, override with `SEED_PASSWORD`).
Your role decides which console opens:

| Account | Role | Console |
|---|---|---|
| `salma@mdm.local`, `karim@mdm.local`, `noor@mdm.local` | Onboarding Agent | `/oa` |
| `shiftlead@mdm.local`, `manager@mdm.local` | Shift Lead, Manager | `/oa` (Admin workspace) |
| `yassine@mdm.local`, `rania@mdm.local`, `omar@mdm.local` | Account Manager | `/am` |
| `admin@mdm.local` | Administrator / Head of AM | `/oa` and `/am` |

Both consoles are the reference prototypes (`reference/*.html`, normative for layout and wording)
served unchanged apart from removing their in-browser demo data; `public/assets/*-adapter.js` wires
every view and action to the API. The `العربية` button switches the UI to Arabic, right-to-left.

## Deploy (Railway)

`npm start` runs `scripts/start.js`. It updates the database schema, seeds the configuration,
team, templates and macros (idempotent), then starts the server on `PORT`.

1. Add a **Volume** to the service, mounted at `/data`. The SQLite database and the sign-in secret
   live there; without it they are wiped on every redeploy.
2. Variables (all optional — sensible defaults apply):
   - `SEED_PASSWORD` — the first password for the seeded accounts. If unset, a random one is
     printed once in the first deploy log (`Users: 10 created … Initial password: …`).
   - `JWT_SECRET` — otherwise generated once and kept on the volume.
   - `DATABASE_URL` — otherwise `file:/data/mdm.db`.
   - Integration keys from `.env.example` when the client provides them.
3. **Settings → Networking → Generate Domain** so the service is reachable.

Health check: `GET /api/health` (configured in `railway.json`).

## Integrations

All optional. Each one is configured by environment variables (see `.env.example`); without them the
app runs on imported or seeded data and the Admin's `/integrations` page says what is not connected.

| Connector | Endpoint | Auth |
|---|---|---|
| MDM platform, pushed events (`merchant.registered`, `order.created`, `seller.metrics`) | `POST /api/integrations/mdm/events` | `X-MDM-Key` = `MDM_WEBHOOK_SECRET` |
| MDM platform, pull sync (hourly, or "Sync now") | `GET {MDM_API_URL}/sellers?updated_since=…` | `x-api-key` = `MDM_API_KEY` |
| WhatsApp Cloud API webhook (messages, delivery statuses) | `GET`/`POST /api/integrations/whatsapp/webhook` | verify token + `X-Hub-Signature-256` |
| Yeastar PBX call events and presence | `POST /api/integrations/yeastar/events` | `X-Yeastar-Secret` |
| Zoho CRM import (CSV or Excel, leads or sellers) | `/integrations` page → `POST /api/integrations/import` | Admin sign-in |

Connectors only write the seller *mirror* (orders, delivery, wallet, catalogue). Health score and
lifecycle stage are refused if sent; the nightly recompute derives them. Webhook retries are
idempotent (provider message ids are stored once). Every import is previewed first and committed as
one audited run.

## Tests

```bash
npm test
```

The acceptance criteria from both specs (AC-OA-1..24, AC-01..27) each have a test named after them in
`tests/acceptance-*.test.js`; `docs/acceptance.md` maps each one and lists what still needs a live
demonstration (two-person and settings-by-Operations criteria).
