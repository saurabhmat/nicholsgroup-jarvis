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
      other_company: /already connected elsewhere in Jarvis/,
      one_account: /You have connected as many Teams accounts as this company allows\. Disconnect one to connect another\./,
      other_person: /already connected by another person/,
    };
    // `already_connected` is a SUCCESS sub-code (T-294), `not_set_up` a connect-time one: both have their own tests
    expect(Object.keys(TEAMS_REFUSALS).sort()).toEqual([...Object.keys(expected), "already_connected", "not_set_up"].sort());
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

describe("T-294: several accounts, the new results", () => {
  const ok = (params: Record<string, string>, teams?: Parameters<typeof connectResultMessage>[2]) => connectResultMessage({ connect: "ok", provider: "microsoft_teams", ...params }, undefined, teams);

  it("a connect that landed on an account the person already had says so, with the picker hint; without the sub-code it is the plain success", () => {
    const again = ok({ detail: "already_connected" });
    expect(again?.tone).toBe("success");
    expect(again?.title).toBe("That Teams account was already connected");
    expect(again?.description).toBe("That Teams account was already connected; its sign-in was refreshed. To add a different account, choose it on Microsoft's page (\"Use another account\"). If Microsoft did not let you choose, sign out of the other account at Microsoft or use a private browser window, then try again.");
    expect(ok({})?.title).toBe("Teams connected");
    // the sub-code never changes another provider's success text
    expect(connectResultMessage({ connect: "ok", provider: "google", detail: "already_connected" })?.title).toBe("Google connected");
  });

  it("a refused Teams reconnect names the person's own row's address when the page found it, and only then; nothing from the address bar is put in a sentence", () => {
    const named = connectResultMessage({ connect: "wrong_account", provider: "microsoft_teams", conn: "00000000-0000-4000-8000-0000000000aa" }, undefined, { messagesShown: true, reconnectAccount: "second@teams.example.test" });
    expect(named?.description).toContain("Microsoft signed in a different Teams account.");
    expect(named?.description).toContain("Try again and choose second@teams.example.test.");
    expect(named?.description).toContain("Nothing was saved");
    const unnamed = connectResultMessage({ connect: "wrong_account", provider: "microsoft_teams", conn: "<script>x</script>" }, undefined, { messagesShown: true, reconnectAccount: null });
    expect(unnamed?.description).toContain("choose the account you are reconnecting");
    expect(unnamed?.description).not.toContain("<script>");
    // Google's wrong-account text is unchanged
    expect(connectResultMessage({ connect: "wrong_account", provider: "google" })?.description).toContain("You chose a different Google account than the one being reconnected");
  });
});
