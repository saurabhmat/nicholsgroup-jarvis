// T-280: the Settings banner after a Teams connect, reconnect or disconnect: fixed text keyed by allowlisted codes (provider=microsoft_teams); nothing from the URL is rendered.
import { describe, expect, it } from "vitest";
import { connectResultMessage } from "./connect-result";

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
    expect(q("account_refused")?.description).toContain("you already have a Teams account connected");
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
