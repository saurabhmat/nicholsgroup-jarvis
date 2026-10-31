// Policy test (T-016 review L1, M2): pins what the local Supabase config exposes. Changing these is a reviewed
// decision (docs/plan-review.md §7 "Core and audit schemas over the API"); production must match by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./lib-workspaces.mjs";

const toml = readFileSync(join(ROOT, "supabase/core/supabase/config.toml"), "utf8");
/** Value of `key = ...` inside `[section]` (top-level keys of that section only). */
const valueIn = (section, key) => {
  const body = toml.split(/^\[/m).find((part) => part.startsWith(`${section}]`));
  const line = body?.split("\n").find((l) => l.trim().startsWith(`${key} =`));
  return line?.split("=").slice(1).join("=").trim();
};

test("the API exposes exactly public, graphql_public, core and audit (never vault, auth, storage or an NL schema)", () => {
  assert.deepEqual(JSON.parse(valueIn("api", "schemas")), ["public", "graphql_public", "core", "audit"]);
});

test("access tokens are short-lived (architecture §9: short sessions)", () => {
  const expiry = Number(valueIn("auth", "jwt_expiry"));
  assert.ok(expiry > 0 && expiry <= 900, `jwt_expiry is ${String(expiry)}`);
});

test("email sign-in is on, but nobody can sign up (invite-only)", () => {
  assert.equal(valueIn("auth", "enable_signup"), "false");
  assert.equal(valueIn("auth.email", "enable_signup"), "true"); // the CLI's email provider switch
  assert.equal(valueIn("auth", "enable_anonymous_sign_ins"), "false");
  assert.equal(valueIn("auth.email", "otp_length"), "6");
});
