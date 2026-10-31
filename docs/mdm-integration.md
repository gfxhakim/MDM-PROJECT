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

**Each seller's figures:**

- `POST /api/v2/orders/search` filtered by `sellerId` and `createdAt` gives:
  - the order count for each of the last 8 weeks
  - lifetime orders
  - the date of the last order
- `GET /api/v2/orders/statistics/statuses` gives delivery, return and cancel rates over 8 weeks.
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
