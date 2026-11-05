# T-199 security review (Nov 5, 2026)

Verdict: no BLOCKER, no HIGH.

What checks out:
- **Lane scoping and RLS.** Reads go through `requireRole(lane, CONNECT_ROLES)` and the user's own lane client. RLS requires AAL2 and the role views; every query filters by `lane_id`.
- **Tokens and cursor values.** No token columns are granted, and `cursor_value` is neither granted nor selected.
- **Content.** No subjects, senders or event titles appear on the page.
- **Rule 5.** No external write.
- **CSRF.** The start route is POST-only with an exact Origin check, and it checks role and AAL2 again.
- **e2e helper.** It uses `execFileSync` with an argument array and stdin, and runs only constant SQL against the local container.

Findings:
- **M1:** the negative-role e2e ran with no connection seeded. **Fixed:** it now seeds one and asserts no details are shown; an admin_technical positive test was added.
- **M2:** the e2e cleanup deleted every Google connection in every lane. **Fixed:** it deletes only the synthetic id, and the spec stops if a real PKG Google connection exists.
- **L1:** the helper trusts the Docker context. **Logged** in `docs/plan-review.md`.
- **L2:** duplicate React keys were possible. **Fixed:** the key is now the connection id.
- **L3:** the whole lane config was read. **Fixed:** only `config->mailboxes` is read.
- **L4:** mailbox case handling. **Checked:** it is the same lower-case compare as `packages/connectors/src/google/guard.ts`.
