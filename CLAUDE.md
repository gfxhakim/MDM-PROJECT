# MDM PROJECT

One web app for MDM Express containing two role-scoped consoles built on a single shared core:

- **Onboarding Agent (OA) module** — takes a new merchant from registration to an activated account. Spec: `docs/MDM-Onboarding-Agent-Module-Spec.pdf` (63 pages). UI reference: `reference/mdm-oa-console.html`.
- **Account Manager (AM) module** — takes the activated seller onward: portfolio, health score, playbooks, churn prevention. Spec: `docs/MDM-Account-Manager-Module-Spec.pdf` (61 pages). UI reference: `reference/mdm-am-console_6.html`.

Both specs describe modules built INSIDE a parent "Omnichannel Support Platform" (spec v1.3 — the client has not provided it). **We implement that core ourselves inside this app**: contacts, conversations, tickets, routing rules, roles/permissions, audit log. The client's existing MDM e-commerce platform (orders, parcels, wallet, catalogue) is linked later via an API key through a pluggable connector; until then the app runs on imported/seeded data.

## Normative hierarchy
1. The two PDFs are normative for **behaviour** (formulas, rules, permissions, state machines).
2. The two HTML prototypes are normative for **layout and wording** — the final UI must look like them (they include an Agent/Admin role switcher and hash routes).
3. Where prototype and PDF disagree on behaviour, the PDF wins.

## Stack
Node 22 (ESM) + Express + Prisma + SQLite in dev (`prisma/schema.prisma` is already written — switch datasource to PostgreSQL for production). JWT auth (bcryptjs + jsonwebtoken). Frontend: adapt the two prototype HTML consoles to call the real API (they currently run on seeded in-browser data). Full Arabic RTL + English support is an acceptance criterion (AC-OA-24).

## Non-negotiable rules from the specs (do not "simplify" these away)
- **No second datastore, no second composer.** One contact, one conversation per merchant, for life. The OA and AM screens dock the SAME conversation component; closing a ticket never closes the conversation.
- **Agents never pick leads.** No claim/self-assign path anywhere, UI or API (AC-OA-4). OA assignment = most free minutes on the market (capacity formula, OA Part 4.2); AM assignment = same market + lowest book, no cross-market fallback (AM Part 3.2).
- **Permissions enforced server-side.** Hiding a button is not the control. OA agents: read all team tickets, write own only; cost/margin/settlement fields are ABSENT from API responses for agents. AMs see ONLY their own book — a foreign seller returns not-found (AC-20). Disabled controls always state their reason.
- **Health score and lifecycle stage are derived, never writable** by any role through any endpoint (AC-03). Implement the AM Part 4.2 formulas EXACTLY, including the engagement fallback redistribution (weights 40/35/0/15/10 while `engagementLive=false`) and the inactivity floor (caps Order Activity at 40/20/5 at `inactiveDays`/`saveDays`/`churnDays`). Health weights must total 100 or config publish is refused.
- **AM rules may open tasks / emit alerts / upgrade in place — never send messages, never close tasks, never reassign** (AC-12). Rule sweep must be idempotent: running twice opens zero new tasks (AC-09). One-call-one-task precedence: save > health-critical > order-decline > inactivity check-in; a seller crossing Critical with an open cadence check-in gets that task UPGRADED in place, not a second task (AC-10/11).
- **OA cadences:** no-answer (counter `attempt_no`, default 5 attempts / 1-day gap, agent-logged, never fabricated by rules) and went-quiet (counter `followup_no`, default 3 templates / 3-day gap, sent by rule r5 only with template budget remaining). Inbound reply resets both counters exactly ONCE per ticket (`cadence_reset` guard).
- **OA activation gate:** all 5 qualification booleans true + all 8 handoff-record fields non-empty, enforced in the service (AC-OA-15). Activation transfers contact ownership to the AM, closes the ticket, leaves the conversation open, fires the AM module's rule r1 (welcome task due in `welcomeCallH`, default 24h).
- **24-hour WhatsApp session window enforced server-side:** free text blocked outside it; only approved templates, each marked billable. Template budget check (monthly ceiling + per-contact cap, default 8) on every automated send.
- **Both ticket types carry `counts_toward: none`** — they never enter support SLA/CSAT metrics.
- **Configuration over code:** every parameter in both Appendix D tables (cadence numbers, minute values, health weights, bands, thresholds, ceilings, labels) lives in versioned config with **draft → simulate → publish → rollback**; publish writes a FULL snapshot (never a diff), rollback restores a snapshot exactly (AC-24), publish triggers an immediate rule sweep (AC-25). Simulation must mutate nothing (AC-23).
- **Playbook gates** (AM 30-day playbook) are read live from the seller record; a step whose gate is false cannot be ticked (AC-14).
- **Everything audited** in one immutable EventLog: state changes, assignments, config publishes, take-overs, bulk runs (one entry with the full affected list, per-ticket permission results reported honestly).

## Build order (matches the specs' phases)
1. ✅ Scaffold + Prisma schema (`prisma/schema.prisma` — done, review it first)
2. Default config seed (every Appendix D parameter from BOTH specs) + config service (draft/simulate/publish/rollback)
3. Auth + roles + server-side scope middleware
4. Platform core API: contacts, conversations, messages (session-window enforcement), tickets, event log
5. OA engine: capture rule r1, capacity/availability formula, pick_agent, holding queue sweep, both cadences, macros, state machine, activation+handoff
6. AM engine: handover r1, health engine + nightly recompute, lifecycle derivation, rule sweep r2–r13 with precedence/dedup, capacity model (cadence as a RATE, AM Part 8.2), playbooks with live gates
7. Frontend: adapt `reference/mdm-oa-console.html` and `reference/mdm-am-console_6.html` to the API, keeping their exact layout/wording; add login + role switch; AR/EN with RTL
8. Admin workspaces: operations/performance dashboards, conversation monitor (take-over with reason, no composer), bulk actions with guardrails, audit view
9. Integrations last: MDM platform connector (API key), Zoho import (CSV/Excel upload), WhatsApp Business API, Yeastar (optional — degrade gracefully)
10. Tests mapped 1:1 to the acceptance criteria (OA Part 15: AC-OA-1..24; AM Part 14: AC-01..27)

## Open business decisions (seed conservative defaults as config; never hardcode)
- OA: monthly template budget (seed low), open-lead ceiling (12), KPI targets
- AM: coverage gap (~1,051 sellers vs 3 AMs at maxBook 50 — Operations screen must state the gap in full), F5 activity timestamps (keep `engagementLive=false`), structured save-task outcome (rule r11 stays off), day-60 review
