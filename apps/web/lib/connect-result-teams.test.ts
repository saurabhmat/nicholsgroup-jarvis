// T-280: the Settings banner after a Teams connect, reconnect or disconnect: fixed text keyed by allowlisted codes (provider=microsoft_teams); nothing from the URL is rendered.
import { describe, expect, it } from "vitest";
import { connectResultMessage, TEAMS_REFUSALS } from "./connect-result";

const q = (connect: string, extra: Record<string, string> = {}) => connectResultMessage({ connect, provider: "microsoft_teams", ...extra });

describe("Teams connect results", () => {
  it("ok: Teams connected, with no 'data syncs' claim", () => {
    expect(q("ok")).toMatchObject({ tone: "success", title: "Teams connected" });
    expect(q("ok")?.description).not.toMatch(/sync/i);
  });
  it("admin_consent_required: the fixed administrator text, nothing saved", () => {
    const m = q("admin_consent_required");
    expect(m).toMatchObject({ tone: "alert", title: "Teams needs administrator approval" });
    expect(m?.description).toContain("Your organisation's Microsoft admin must approve the portal's Teams app once");
    expect(m?.description).toContain("Nothing was saved");
  });
  it("account_refused / wrong_tenant / wrong_account name Teams and say nothing was saved; the remove-access notice names where to remove the app", () => {
    for (const code of ["account_refused", "wrong_tenant", "wrong_account"]) {
      const m = q(code, { notice: "remove_app_access" });
      expect(m?.tone, code).toBe("alert");
      expect(m?.description, code).toContain("Nothing was saved");
      expect(m?.description, code).toContain("My Apps");
    }
    // without a sub-code: the short neutral sentence
    expect(q("account_refused")?.description).toBe("The Teams account was not accepted. Try again, or ask your administrator. Nothing was saved.");
  });

  it("each fixed sub-code has its own short, correct sentence (C1)", () => {
    const expected: Record<string, RegExp> = {
      domain: /not on a sign-in domain this company allows/,
      guest: /Guest accounts cannot be connected/,
      scope_missing: /did not grant a permission that Teams needs/,
      scope_extra: /permission that the Teams connection may not hold/,
      not_enabled: /Teams is not enabled for this company/,
      other_company: /already connected to another company/,
      one_account: /You already have a Teams account connected for this company/,
      other_person: /already connected by another person/,
    };
    expect(Object.keys(TEAMS_REFUSALS).sort()).toEqual([...Object.keys(expected), "not_set_up"].sort());
    for (const [detail, re] of Object.entries(expected)) {
      const m = q("account_refused", { detail });
      expect(m?.tone, detail).toBe("alert");
      expect(m?.description, detail).toMatch(re);
      expect(m?.description, detail).toContain("Nothing was saved");
    }
  });

  it("an unknown, empty or crafted sub-code falls back to the neutral sentence and is never rendered", () => {
    for (const detail of ["nope", "", "__proto__", "constructor", "<script>x</script>", "domain ", "DOMAIN"]) {
      const m = q("account_refused", { detail });
      expect(m?.description, detail).toBe("The Teams account was not accepted. Try again, or ask your administrator. Nothing was saved.");
    }
    // a sub-code never changes another provider's text
    expect(connectResultMessage({ connect: "account_refused", provider: "microsoft", detail: "guest" })?.description).not.toContain("Guest accounts");
    expect(connectResultMessage({ connect: "account_refused", provider: "google", detail: "guest" })?.description).not.toContain("Guest accounts");
  });

  it("Microsoft's invalid_scope (the company lists a feature the Teams app lacks) is 'not fully set up', not 'Connection cancelled' (C6)", () => {
    for (const code of ["denied", "exchange_failed"]) {
      const m = q(code, { detail: "not_set_up" });
      expect(m?.title, code).toBe("Teams isn't fully set up");
      expect(m?.description, code).toContain("Ask your administrator");
    }
    expect(q("denied")?.title).toBe("Connection cancelled");
  });

  it("the success text points to Messages only where the page is switched on (C4)", () => {
    const on = connectResultMessage({ connect: "ok", provider: "microsoft_teams" }, undefined, { messagesShown: true });
    const off = connectResultMessage({ connect: "ok", provider: "microsoft_teams" }, undefined, { messagesShown: false });
    expect(on?.description).toContain("Open Messages to use it.");
    expect(off?.description).not.toContain("Open Messages");
    expect(off?.description).toContain("Messages is not switched on for this company yet");
  });
  it("disconnected: a neutral Teams text that is not shown for another provider's code", () => {
    expect(q("disconnected")).toMatchObject({ tone: "success", title: "Teams disconnect" });
    expect(q("consent_ok")).toBeNull();
    expect(q("consent_failed")).toBeNull();
  });
  it("a crafted value never reaches the page", () => {
    const m = connectResultMessage({ connect: "ok", provider: "microsoft_teams", title: "<script>x</script>", notice: "<b>x</b>" });
    expect(JSON.stringify(m)).not.toContain("<script>");
    expect(connectResultMessage({ connect: "<script>", provider: "microsoft_teams" })).toBeNull();
  });
});
