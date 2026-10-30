# Acceptance criteria → tests

Every criterion in OA Part 15 and AM Part 14 has one automated test named after it:

- `tests/acceptance-oa.test.js`: AC-OA-1 to AC-OA-24
- `tests/acceptance-am.test.js`: AC-01 to AC-27

Run them with `npm test`, which also runs the per-step suites.

The specs say criteria are *demonstrated, not described*. The tests prove the behaviour through the same API the consoles use. A few criteria also need a live demonstration with people at the keyboard. Those are marked **Live** below.

## Onboarding Agent (OA Part 15)

| AC | What the test checks | Live |
|---|---|---|
| AC-OA-1 | Unknown number: one contact, one conversation, one assigned ticket; stage, due date and source set; assignee notified | |
| AC-OA-2 | Message then portal registration with the same phone: one contact, one ticket | |
| AC-OA-3 | Same market. Agent with 3 walkthroughs today loses the lead to the agent with none | |
| AC-OA-4 | No claim control in the console. Reassign, over-capacity, bulk, take-over and assignee patch are all refused for an agent | |
| AC-OA-5 | Lead held at the ceiling with a reason; assigned by the next sweep once a lead closes | |
| AC-OA-6 | Five no-answers: attempt_no 1→5, Failed to Contact, next attempt at the configured gap, then Cold with a logged r4 reason | |
| AC-OA-7 | Reply resets once. The second reply does not reset, and the cadence still cuts off at 5 | |
| AC-OA-8 | Budget below usage: no send. Tag, system line in the conversation and agent notification, shown once | |
| AC-OA-9 | A Manager publishes `oa.no_answer_max` = 7. The ticket's cadence tracker and the r3 reminders follow it | **Live (CFG)**: an Operations user does it in Automation, with no developer |
| AC-OA-10 | Code scan: only `core/conversations.js` writes outbound messages or emits `message.sent`. Both consoles post through `/api/conversations/:id/messages` | |
| AC-OA-11 | Remaining window time is returned. Free text gets 409 `window_closed`; an approved template still goes, billable | |
| AC-OA-12 | Colleague's ticket: read and note allowed. Reply, transition, activate and log-call get 403 with reasons | |
| AC-OA-13 | Presence API: viewing, typing, left and expiry; foreign readers get 404; both consoles render the live banner | **Live (2P)**: checked in two browsers. A typing agent appears as "is replying" on the other screen |
| AC-OA-14 | All six macros state what they apply and apply it. Five send nothing; Send Hub sends `oa_hub_share_v1`, as the spec's 6.5 table says. Book inserts its text | |
| AC-OA-15 | An incomplete criteria list or a blank handoff field gets 422, for the agent and for an Admin calling the service | |
| AC-OA-16 | Activation: owner becomes the AM, ticket closed, same conversation readable by the AM with its full history | |
| AC-OA-17 | `counts_toward: none` on both ticket types; no survey or CSAT send on close | |
| AC-OA-18 | Analytics recomputed independently from tickets. The CSV export's numbers equal the screen's, and the export writes one audit entry | |
| AC-OA-19 | A published config change appears in `marks` with its week and note, on the chart's axis | |
| AC-OA-20 | Every `oa.*` parameter has a non-developer owner who can draft it through `/api/config`; agents are refused | **Live (CFG)**: walk Part 12.1 row by row with an Operations user |
| AC-OA-21 | Simulate changes nothing. Publish is attributed (author and note). Rolling back to before two changes restores every key | |
| AC-OA-22 | Admin reads a colleague's conversation with no composer; take-over needs a reason; the audit names actor, previous owner and reason | |
| AC-OA-23 | Mixed bulk batch: each ticket checked, partial failure reported per ticket, unselected tickets untouched, one audit entry. Agents get 403 | |
| AC-OA-24 | RTL switch, dictionaries loaded on both consoles, state kept across the switch | **Live**: switch language on every screen mid-task. Checked in a browser that the route and an unsent draft survive |

## Account Manager (AM Part 14)

| AC | What the test checks | Live |
|---|---|---|
| AC-01 | Handover in LY, LB and IQ: lowest book in the market, SELLER_ASSIGNED event, AM notified, welcome task within `welcomeCallH` | |
| AC-02 | Full market: unassigned, Admin alerted, counted in the "Sellers with no account manager" quality check; no IQ fallback, no ceiling breach | |
| AC-03 | Health and stage writes refused on every route, including the MDM connector | |
| AC-04 | Extreme sellers score 0–100; weights total 100 with engagement on and off | |
| AC-05 | 40/35/0/15/10 fallback; 30/25/20/15/10 when live | |
| AC-06 | Floor of 40/20/5 at `inactiveDays`/`saveDays`/`churnDays`; recent growth plus 31 days inactive scores 5 | |
| AC-07 | Each of the five components has a sentence that names its values | |
| AC-08 | Injected database failure: yesterday's scores kept exactly, flagged stale, Admin alerted, failure audited | |
| AC-09 | A second sweep opens 0 tasks and upgrades 0 | |
| AC-10 | Seller meeting r2, r3, r4 and r5 at once: exactly one call task, the r5 save | |
| AC-11 | r13 check-in upgraded in place to intervention, urgent, due today; no second task | |
| AC-12 | Sweeps over 45 days: no messages, no billable sends, no closes, no reassignments | |
| AC-13 | Reason required; escalated flag set; Admin notified; audited; owner and conversation unchanged | |
| AC-14 | Day-3 step with 2 products gets 422 naming "≥ 3 products", for the AM and the Admin | |
| AC-15 | Days 3, 5, 7, 14, 21 and 30 each open one task on their own day, at normal priority. Late steps open at high. Days 0 and 1 are the handover and the r1 welcome task | |
| AC-16 | An open r13 check-in leaves `committed` unchanged | |
| AC-17 | Closing a task lowers `committed` | |
| AC-18 | Capacity reports the binding constraint together with free time, headroom and seats | |
| AC-19 | Every book filter and the console bundle return only the caller's sellers | |
| AC-20 | Six seller and task routes return 404 for a foreign seller, identical to a seller that does not exist; Admin gets 200 | |
| AC-21 | Grants and refusals carry reasons; closed tasks say why; foreign sellers are never sent to the page | **Live**: check the disabled controls on screen |
| AC-22 | Weights totalling 105 are refused, and the refusal names 105 | |
| AC-23 | Snapshot of tickets, sellers, notifications, events, history and messages is identical after simulate | |
| AC-24 | Three publishes, then a rollback to the first: every key matches its snapshot | |
| AC-25 | Tasks opened by publish = simulate's prediction = the publish result | |
| AC-26 | `am_task` has `counts_toward: none` and never appears in onboarding reporting | |
| AC-27 | NRR, upgrades and CSAT come back null, never 0. A KPI with no value says "not wired yet" instead of showing a number | |

## Gaps found while mapping, now fixed

- **AC-OA-13 collision detection.** The prototype only had a demo flag. Live presence is now in place: `POST /api/conversations/:id/presence` plus `public/assets/presence.js`, with a banner in both consoles.
- **AC-OA-8 visible suppression.** r5 only reported the skip in the sweep result. The lead now carries an `oa_followup_suppressed` tag, a system line in the conversation and a notification to the agent.
- **AC-OA-6.** The automatic move to Cold is now its own audited event with the r4 reason.
- **AC-OA-18 exports.** The Export buttons were placeholders. They now download CSVs (`GET /api/oa/export/performance|leads`), are Admin-only and write one audit entry each.
- **AC-OA-14.** `GET /api/oa/macros` now states what each macro applies.
- **AC-OA-23 and AC-OA-4.** Bulk is refused outright for roles without `onboarding.bulk_internal`.
- **AC-02.** The quality check "Sellers with no account manager" was hard-coded to 0. It is now counted from the record.
- **AC-13.** Escalation now notifies the Admin as the next owner.
- **AC-27.** Any KPI without a value now says "not wired yet", not only the survey ones.
- **Composer.** Both prototypes wrote "Write a reply…" as real text, so it ended up in sent replies. It is now a CSS placeholder.

## Open points for the client

- **OA 6.5 contradicts itself.** The text says a macro "never sends", but the table says "Send Hub instead of a call" sends `oa_hub_share_v1`. The table is implemented. If the client prefers the text, this one macro would insert the Hub link into the composer instead of sending it.
