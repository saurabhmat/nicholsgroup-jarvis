# T-210 follow-up review (sensitive-number screen + retention catalog), security-reviewer, Nov 7, 2026

Saved by the main session. BLOCKER: none.
- H-1 ReDoS in the TS bank regex (cubic on long whitespace runs). **Fixed**: label scan + fixed 80-char window with bounded quantifiers; 32 KB adversarial perf tests in Vitest (< 250 ms each) and pgTAP (< 2 s for four together).
- H-2 card + expiry/CVV missed. **Fixed**: digit sequences split into groups; every card-layout sub-run (single 13-19, 4-4-4-4[+1-3], 4-6-4/5) is Luhn-checked.
- H-3 markdown labels missed. **Fixed**: up to 10 chars of `[ \t*_|:#.=\n-]` plus "number/num/no/nr" and "is" between label and number; digits may be split by single spaces/dashes.
- M-1 date-pair false positives. **Fixed** by the card-layout rule; Vitest loops over a year of date pairs.
- M-2 SSN bypasses (label hyphen, trailing dash, en dash, full-width digits). **Fixed**: lookbehind/lookahead for longer dashed numbers only; NFKC + Unicode dashes normalised in TS and SQL.
- M-3 unscreened columns. **Fixed**: documents.path, employees.config, import_candidates.target_path added (trigger and store).
- M-4 test parity. **Fixed**: shared fixture `supabase/core/supabase/tests/fixtures/brain_sensitive_cases.json` (48 cases); pgTAP block generated from it; Vitest parity test fails if a case is missing in SQL; full messages asserted.
- L-1 unknown trigger column now raises. L-2 ledger accounts: decided — "account"/"acct" needs 8–17 digits, so "Account 400100" saves (logged). L-3 brain.imports now `until_deleted` (the job only closes runs). L-4 noted.
