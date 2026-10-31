# MDM platform integration

The only connector switched on for now. Three directions, each switched on by a setting in Railway's
**Variables**.

| Setting | Turns on |
|---|---|
| `MDM_API_KEY` | Reading MDM's API every 15 minutes (`MDM_SYNC_MINUTES`) |
| `MDM_WEBHOOK_SECRET` | Receiving events MDM pushes to us |
| `MDM_WRITEBACK_URL` | Sending our updates to MDM every 60 seconds (`MDM_PUSH_SECONDS`) |

## 1. Reading MDM (API key)

Built against the public MDM API (`https://api.mdm.express`, header `x-api-key`):

- `POST /api/stores/search`: every store, paged with `pagination: { page, perPage }`. Each `sellerId`
  is one merchant. After the first run, only stores whose `updatedAt` is after the last sync.
- `POST /api/v2/orders/search` filtered by `sellerId` and `createdAt`: order counts per week for the
  last 8 weeks, lifetime orders and the last order date.
- `GET /api/v2/orders/statistics/statuses` filtered by `sellerId`: delivery, return and cancel
  rates over the last 8 weeks.
- After the first run, `POST /api/v2/orders/search` filtered by `updatedAt` finds the sellers whose
  orders changed, and only those are refreshed.

What happens to each store:

- **A seller we already have:** its figures are updated. Owner, health and stage are untouched.
- **A seller with orders that we don't have:** it joins the book. The account manager is picked
  from the same market, with the smallest book. A welcome task is opened only if the seller was
  activated in the last 14 days.
- **A store with no orders yet:** it becomes an onboarding lead, assigned by the normal rules.
- **Already a lead here:** left alone. A lead is activated through the onboarding flow, so the
  activation checks still apply.

**To confirm with the MDM team.** The public docs stop before the field lists, so the field names
used are a best reading. They are all in one file, `src/integrations/mdm-api.js`:

- store `sellerId`, `phones`, `name`, `country` and `createdAt`
- order `sellerId` and `createdAt`
- `pagination.total` and `pagination.hasMore`
- status names that contain *deliver*, *return* or *cancel*

Also not in the API yet: wallet balance, and the merchant's registration and activation status.

## 2. MDM pushes to us (webhook)

`POST https://<our-domain>/api/integrations/mdm/events`, with the header `X-MDM-Key: <MDM_WEBHOOK_SECRET>`.
The body is one event or `{ "events": [ … ] }`, up to 500 per call.

```json
{ "type": "merchant.registered", "data": { "phone": "+218915550020", "name": "Huda", "country": "LY", "utm": "fb_ads" } }
{ "type": "seller.upserted",     "data": { "mdmRef": "SELLER_ID", "phone": "+218…", "name": "…", "country": "LY",
                                           "activatedAt": "2026-01-10T00:00:00Z", "metrics": { "totalOrders": 120 } } }
{ "type": "order.created",       "data": { "mdmRef": "SELLER_ID", "at": "2026-10-31T10:00:00Z" } }
{ "type": "seller.metrics",      "data": { "mdmRef": "SELLER_ID", "metrics": { "deliveryRate": 82, "products": 14, "wallet": 310.5 } } }
```

Accepted `metrics` fields:

- `weeklyOrders` (8 numbers, oldest first) and `weeklyReturnRates`
- `deliveryRate`, `returnRate` and `cancelRate`
- `wallet` and `walletNegativeDays`
- `products`, `marketsServed` and `momGrowthPct`
- `lastOrderAt` and `totalOrders`
- `lastLoginAt`, `lastStoreUpdateAt` and `lastProductAddedAt`

`healthScore`, `healthBand` and `stage` are refused: our app derives them.

Each event gets its own result: `{ "results": [ { "ok": true, … } ] }`.

## 3. Our updates go back to MDM (write-back)

Every state change in this app goes into the audit log. The write-back sends those changes to
`MDM_WRITEBACK_URL` in order, oldest first, with the header `x-api-key: <MDM_API_KEY>`. A batch
that MDM refuses (any non-2xx answer) is sent again unchanged on the next try, so nothing is lost
or sent out of order. `id` is unique per event: use it to ignore repeats.

```json
{ "events": [ {
  "id": "cmh…", "type": "ticket.reassigned", "at": "2026-10-31T17:40:00Z",
  "by": { "name": "Haithem", "email": "admin@…", "role": "ADMIN" },
  "before": { "assigneeId": null }, "after": { "assigneeId": "…" }, "reason": "Covering Libya today",
  "merchant": {
    "sellerId": "SELLER_ID or null for a lead", "phone": "+218915558800", "name": "Huda", "country": "LY",
    "onboarding": { "status": "Assigned", "stage": "…", "agent": { "name": "Salma Ben Ali", "email": "…" }, "activatedAt": null },
    "accountManager": { "name": "Yassine Trabelsi", "email": "…" },
    "health": { "score": 72, "band": "Healthy", "computedAt": "…" },
    "lifecycleStage": "Growing"
  }
} ] }
```

Event types sent:

- **Onboarding:** `ticket.assigned`, `ticket.reassigned`, `ticket.taken_over`, `ticket.status_changed`,
  `ticket.held`, `ticket.call_logged`, `ticket.walkthrough_booked`, `ticket.hub_sent`,
  `ticket.followup_sent` and `ticket.activated`
- **Account management:** `SELLER_ASSIGNED`, `seller.reassigned`, `seller.accepted`, `seller.churned`,
  `seller.call_logged` and `seller.unassigned_alert`
- **Tasks:** `am_task.opened`, `am_task.upgraded`, `am_task.rescheduled`, `am_task.escalated`,
  `am_task.closed` and `playbook.ticked`

Never sent:

- MDM's own figures (orders, wallet, catalogue). They are read-only here.
- Anything that came from MDM in the first place.

**The MDM team needs to provide** an endpoint that accepts this body, or tell us their own format
so we can map to it. The public API only edits stores and products, so it has nowhere to store
these results yet.
