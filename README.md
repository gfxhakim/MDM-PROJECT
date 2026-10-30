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
