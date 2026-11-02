# MDM platform integration

This is the only connector switched on for now. It is built on MDM's own OpenAPI spec
(`https://api.mdm.express/api/docs/swagger`), using the endpoints listed below. All calls use the
header `x-api-key: MDM_API_KEY`.

| Setting (Railway → Variables) | Effect |
|---|---|
| `MDM_API_KEY` | Turns on reading from MDM, every `MDM_SYNC_MINUTES` (default 15) |
| `MDM_WRITEBACK=on` | Turns on recording our work on MDM, every `MDM_PUSH_SECONDS` (default 60) |
| `MDM_PAYMENT_PASSWORD` | Optional. Lets the sync read seller wallet balances |
| `MDM_LEAD_MAX_AGE_DAYS` | Pending registrations older than this are not opened as leads (default 60) |
| `MDM_WEBHOOK_SECRET` | Optional. Accepts pushed events, if MDM ever sends them |

## 1. Reading MDM

**Sellers.** `POST /api/sellers/search`, newest `updatedAt` first.

- The first run (and **Full resync**) reads every seller. Later runs stop at the first seller
  that hasn't changed since the last sync.
- **Market.** MDM writes ISO alpha-3 country codes (`LBY`, `IRQ`, `LBN`, `DZA`, `MAR` …); the app
  names its markets `LY`, `IQ`, `LB`. A seller lives in `country` and sells in `countries`
  (MDM's `servicesByCountry`). The seller's market is where MDM delivers for them: the home country
  when it is Libya, Iraq or Lebanon, otherwise the first of their `countries` that is. A seller with
  none of the three is skipped, and the "Why" panel lists the countries MDM has for them. Wallets
  are read in the seller's market.
- **Accepted on MDM (`joinStatus`):**
  - If we already have the seller, only their figures are updated.
  - If the seller is new here, they join an account manager's book. MDM's account manager is kept
    when they are one of our users with the same email, covers the market and has room. Otherwise
    AM 3.2 applies: same market, smallest book, no cross-market fallback.
  - A welcome task is opened only if the seller was accepted in the last 14 days.
- **Still joining:** the merchant becomes an onboarding lead and goes through the normal capture
  and assignment rules.
  - Registrations older than `MDM_LEAD_MAX_AGE_DAYS` are skipped.
  - Rejected merchants are skipped.
- **Already a lead here:** the lead is linked to its MDM id and otherwise left alone, so the
  activation gate still applies.

**Skipped sellers.** Every seller the pull cannot place is kept aside, with what MDM says about
it (name, phone, home country and selling countries, join status, registration date, MDM's
account manager) and the reason: market outside Libya, Iraq and Lebanon; no valid phone; rejected
on MDM; registration older than `MDM_LEAD_MAX_AGE_DAYS`; already here. The list is on the
Integrations page (Admin only, `GET /api/integrations/mdm/skipped`). For each seller, alone or in
bulk (at most 200 per run, a written note for a bulk run), the Admin can:

- **Place as seller** in Libya, Iraq or Lebanon: a contact, a conversation and a seller record are
  created here, exactly as the import does it. The account manager is picked by AM 3.2 (same
  market, smallest book, no cross-market fallback), or the handover rule r1 when MDM accepted the
  seller in the last 14 days (welcome task); the Admin can name a manager who covers the market and
  has room. The seller's figures are read from MDM by the next sync (one is started at once when
  nothing is running). The assignment reaches MDM through the write-back like any other.
- **Open as lead**: capture rule r1, in the market the Admin chooses.
- **Leave out**, with a reason; a left-out seller can be put back any time.
- A seller already here is only shown: a lead is activated in the onboarding console, so the
  activation gate and the handoff record still apply.

Each seller in a run is handled and reported on its own (a refused seller does not stop the
others); one audit entry per run carries the full list and every result (`mdm.skipped_decided`).
A seller the pull later brings in by its own rules (for example after MDM corrects its country) is
marked *imported*; one we placed or opened comes back on every run as "already here" and keeps
its decision. Nothing on this list is written to MDM. **This list is not in the specs:** it answers
the owner's request of 2 Nov 2026 to keep every skipped seller aside and decide by hand; its
actions are the spec's own mechanisms (AM 3.2, r1, capture r1, OA 13.2 bulk guardrails, one audit
entry).

**People on MDM (staff).** Every run first reads the platform's users (`POST /api/users/search`,
or the older `GET /api/users` when that one is refused) and keeps them aside on the Integrations
page: name, email, phones, MDM usernames, MDM role and group (scope), countries (turned into the
markets here from the country ids learnt from the sellers and the account-manager list), restriction
and last MDM sign-in. Nothing is created by itself: the Admin **imports** each person, alone or in
bulk (200 at most, a written note for a bulk run), with the role they have here (onboarding agent,
account manager, shift lead, manager, read-only, administrator) and, when MDM lists none of Libya,
Iraq or Lebanon for them, the markets; or **leaves them out** (reversible). A person with no email
on MDM cannot be imported (an account here needs one). An account already here with the same email
is linked, not duplicated. A person restricted on MDM is imported switched off, and a later
restriction switches the account off here (and back on when MDM lifts it). One audit entry per
decision run with every item's result (`mdm.staff_decided`). If MDM refuses the users call, the run
goes on with the sellers and the status card says so, so the API key's rights can be extended.

**Their data comes with them** — the spec's migration rules (OA 3.5) applied to the platform:

- **The responsible agent.** MDM's `joinStatusResponsible` is kept on the contact. A lead whose
  responsible agent is one of ours (imported from MDM) is assigned to them — when the lead is
  created, and for leads already here as soon as the person is imported (`alignOwnership`, also at
  the end of every run). A lead already held by another platform person is left alone (a move made
  here was recorded on MDM).
- **The account manager.** MDM's `accountManager` is kept on the seller (`mdmManagerRef`). A new
  seller stays with MDM's account manager when they are one of ours (imported, or the same email);
  sellers already here move to them once they are imported. Two platform people: no move. **This
  keeps MDM's book as it is, past the book ceiling if MDM's book is larger** — the ceiling governs
  the rule's own picks (AM 3.2), not the platform's record; the Operations screen shows the gap.
  The write-back does not send MDM its own assignment back (`fromPlatform`).
- **The join history.** Every mark MDM recorded (`joinStatusHistory`: not answered, follow-up,
  missing documents, accepted … with notes, date and who) is a read-only `legacy` system line in
  the conversation, dated as on MDM and credited to the imported user when they are here. One line
  per mark, however many runs.
- **Original dates and statuses.** A lead's contact and ticket carry MDM's registration date;
  MDM's join status is mapped by meaning (not answered → Failed to contact, follow-up →
  Pre-qualified, missing documents → Pre-qualified at the documents stage, anything else →
  Pre-qualified with a note); **cadence counters start at 0** and the first due date is at the
  import, as the spec requires for migrated leads.

**Sign-in for imported staff.** With their MDM username (or email) and MDM password: the app calls
MDM's `POST /api/auth/login/user`, then `GET /api/auth/me`, and accepts only when the profile is
the same platform user the account was imported from. No API key is involved in that call. An
Admin can also set a password here (Accounts section, at least 8 characters, never logged); then
both ways work. Switching an account off (Accounts section, reason required) sends an agent's open
leads to the holding queue (rule r8 assigns them again by capacity) and each of an account
manager's sellers to the same-market, smallest-book manager, or leaves them unassigned with the
Admin alerted; every change is audited.

**Each seller's figures:**

- `POST /api/v2/orders/search` filtered by `sellerId` and `createdAt` gives:
  - the order count for each of the last 8 weeks
  - lifetime orders
  - the date of the last order
- `POST /api/analytics/orders/sellers-status/search` filtered by `sellerId` and `date` (the last
  8 weeks) is MDM's own reporting row for the seller, one per market: `delivered`, `returned`,
  `cancelled`, `totalLeads`, `totalParcels`, `totalParcelsWithoutLead`. The AM spec (1.2) and the
  OA spec (11.4) say MDM computes delivery and return rates and this app only reads them, so the
  rates come from these counts and are never counted from raw orders here:
  - delivery rate = `delivered` ÷ orders, return rate = `returned` ÷ orders, cancel rate =
    `cancelled` ÷ orders, where orders = `totalLeads` + `totalParcelsWithoutLead` (every order of
    the window). **The spec does not state the denominator.** The Appendix D targets (35 %
    delivery, 24 % returns, 33 % cancelled) only add up on this basis; MDM's own profit calculator
    defines delivery rate per shipped parcel. One question to MDM settles it. The counts are stored
    on the seller (`mirrorInputs`), so the divisor can change without a resync.
  - markets served = the markets (rows) where MDM reports orders or parcels for the seller in the
    window, at least 1.
  - No orders in the window → the rates are left as they are ("no parcels yet"). Counts that cannot
    be right (a rate above 100 %), or no reporting row for a seller that has orders, are reported on
    the Integrations page and nothing is written.
  - `GET /api/v2/orders/statistics/statuses` is **not** used: the live platform answers 500
    (`syntax error at or near "$1"`) when it is filtered by seller.
- `POST /api/finance/seller-payments/wallets/search` gives the wallet's `ready` balance. It needs
  `MDM_PAYMENT_PASSWORD`.
- After the first run, `POST /api/v2/orders/search` filtered by `updatedAt` finds the sellers
  whose orders changed. Their figures are refreshed.

Health score and lifecycle stage are never read from MDM. Our app derives them.

**Real time.** MDM has no outbound webhooks for sellers or orders, so changes arrive with the next
pull: within 15 minutes, or whatever `MDM_SYNC_MINUTES` is set to. For instant updates, MDM would
need to call our webhook. See section 3.

## 2. Our work recorded on MDM (write-back)

Every state change in our app goes into the audit log. The write-back reads that log in order and
turns the relevant entries into MDM's own actions:

| Here | On MDM |
|---|---|
| Onboarding call, no answer | `PATCH /api/sellers/{id}/join/not-answer` with `notes` |
| Call answered, walkthrough booked, status change, activation | `PATCH /api/sellers/{id}/join/followup` with `notes` |
| Account manager assigned or changed | `POST /api/omni-channel/account-managers/sellers/{id}` with `accountManagerId` (our AM matched to MDM's by email) |

**Never pressed automatically:**

- **Accept.** It creates the seller's MDM login (password, services), so MDM staff press it. The
  follow-up note says "Ready to accept on MDM".
- **Reject.** It can't be undone.

**How delivery works:**

- **Start point:** write-back starts from the moment it is switched on. Earlier work isn't replayed.
- **MDM outage** (5xx, timeout, or 401/429): the run stops, and the same entry is retried next time.
- **MDM refuses one record** (other 4xx, for example its flags no longer allow the action): the
  refusal is recorded on the Integrations page and the next entry goes on.

## 3. What we need from the MDM developers

1. An API key that can read all sellers, orders and account managers, and can call the join and
   assign-account-manager endpoints.
2. The `joinStatus` values: which ones mean accepted and which mean rejected. Until then, they are
   read by meaning: *accept/approv/activ* and *reject/refus/declin*.
3. The order `status` values. Until then: *deliver/livr*, *return/retour*, *cancel/annul*.
4. Optional:
   - the wallet `x-payment-password`
   - rate limits
   - a staging environment
5. For instant updates: a call to our webhook `POST /api/integrations/mdm/events` (header
   `X-MDM-Key`) when a seller registers or changes join status, and when an order is created or
   changes status. The accepted bodies:

```json
{ "type": "merchant.registered", "data": { "phone": "+218915550020", "name": "Huda", "country": "LY", "utm": "fb_ads" } }
{ "type": "seller.upserted",     "data": { "mdmRef": "SELLER_TRACKING_ID", "phone": "+218…", "name": "…", "country": "LY", "joinStatus": "accepted" } }
{ "type": "order.created",       "data": { "mdmRef": "SELLER_TRACKING_ID", "at": "2026-10-31T10:00:00Z" } }
{ "type": "seller.metrics",      "data": { "mdmRef": "SELLER_TRACKING_ID", "metrics": { "deliveryRate": 82, "wallet": 310.5 } } }
```
