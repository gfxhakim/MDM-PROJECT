# Roles: who opens what

Every rule below is enforced on the server (`src/auth/permissions.js`, `src/auth/scope.js`); a hidden or
greyed button is legibility, not the control. A role is re-read on every request, so a change made by
the Administrator applies on the person's next click. Tests: `tests/roles.test.js`.

| Role | Opens | Source |
|---|---|---|
| Onboarding agent (`OA_AGENT`) | Onboarding console, agent side: own leads; reads the team queue; leads arrive by capacity in their markets. | OA Part 9, Appendix A |
| Shift lead (`SHIFT_LEAD`) | Onboarding console, team queue and floor view; takes over with a reason. | OA Part 9, Appendix A |
| Manager (`MANAGER`) | Onboarding console, every lead, dashboards, the onboarding settings. | OA Part 9, Appendix A, Appendix D owners |
| Account manager (`ACCOUNT_MANAGER`) | AM console: only their own book (a foreign seller is not-found, AC-20). | AM 9.1, Appendix A |
| Head of AM (`HEAD_OF_AM`) | AM console for every seller, the Head of AM workspace (Operations, Portfolio Health, Team Performance, All Sellers, OmniDesk Monitor, Automation, Health Score & Config, Audit & Quality). | AM 9.1, Appendix A "Admin"; the AM prototype's "Head of AM" |
| Administrator (`ADMIN`) | Everything: both consoles, Platform Settings (MDM connector, people on MDM, accounts), deleting merchants, the whole audit log. | OA Appendix A, AM Appendix A |
| Read-only (`READ_ONLY`) | Onboarding console lists and dashboards, no changes. | OA Part 9 |

## Head of AM — choices made where the specs are silent

The AM spec names two roles, Account Manager and Admin. The Head of AM is that Admin held by its own
account, scoped to the account-management team the way OA 9.2 scopes the onboarding Administrator:

1. Account management: exactly the Admin column of AM Appendix A (reassign with a reason, bulk tasks,
   rule sweep, take-over, block request, team performance, the AM configuration keys).
2. Onboarding: what an account manager holds; the Onboarding (OA) menu item is greyed with its reason.
3. Configuration: only the parameters AM Appendix D gives to "Admin"; onboarding parameters are refused.
4. Audit: the account-management part of the trail (sellers, AM tasks, playbooks, health, configuration,
   conversation take-overs, reassignments, bulk AM runs, blocks on sellers' contacts).
5. Platform Settings, accounts, roles and deleting merchants stay the Administrator's.
6. AM alerts (escalations, save campaigns, unassigned sellers, recompute failures, transfer requests)
   go to both the Head of AM and the Administrator.

## Changing a role

Integrations → Accounts → **Change role** (Administrator only, `roles.manage`): the new role, its
markets (an onboarding agent or account manager needs at least one), and a written reason. The work the
old role held is handed on as when an account is switched off: open leads to the holding queue (assigned
again by capacity), sellers to the manager MDM names for them, else the same-market smallest-book
manager (AM 3.2), else unassigned with the Head of AM and the Administrator alerted. One `user.role_changed`
audit entry with the before/after role and markets. Refused: own account, the same role, a removed
account, and the last active Administrator.
