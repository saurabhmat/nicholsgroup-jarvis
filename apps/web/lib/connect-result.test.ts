import { describe, expect, it } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { connectResultFor, connectResultMessage } from "./connect-result";

describe("connectResultMessage", () => {
  it("shows the fixed 'not configured' banner for the allowlisted error codes and nothing else", () => {
    const m = connectResultMessage({ error: "google_env" });
    expect(m).toEqual({
      tone: "alert",
      title: "Google isn't configured on this server.",
      description: "Check GOOGLE_REDIRECT_URI and NEXT_PUBLIC_APP_URL (same https domain) and redeploy.",
    });
    expect(connectResultMessage({ error: "connect_env" })?.tone).toBe("alert");
    for (const bad of ["<b>x</b>", "constructor", "__proto__", "toString", "GOOGLE_REDIRECT_URI=https://evil.test", "google_env ", ""]) expect(connectResultMessage({ error: bad })).toBeNull();
    expect(connectResultMessage({ error: ["google_env"] })).toBeNull();
    // a crafted text never appears in the banner
    expect(JSON.stringify(connectResultMessage({ error: "google_env", text: "canary-words-77", message: "canary-words-77" }))).not.toContain("canary-words-77");
  });

  it("shows nothing without a connect code", () => {
    expect(connectResultMessage({})).toBeNull();
  });

  it("explains a refused Google account and the leftover grant", () => {
    const m = connectResultMessage({ connect: "account_refused", provider: "google", notice: "remove_app_access" });
    expect(m?.tone).toBe("alert");
    expect(m?.title).toBe("Google account not accepted");
    expect(m?.description).toMatch(/domain this company allows/);
    expect(m?.description).toMatch(/another person/);
    expect(m?.description).toMatch(/Third-party connections/);
  });

  it("explains a reconnect with a different Google account (T-238): nothing saved, and the leftover grant", () => {
    const m = connectResultMessage({ connect: "wrong_account", provider: "google", notice: "remove_app_access" });
    expect(m?.tone).toBe("alert");
    expect(m?.title).toBe("Google account does not match");
    expect(m?.description).toMatch(/Nothing was saved and the connection was not changed/);
    expect(m?.description).toMatch(/Third-party connections/);
    expect(connectResultMessage({ connect: "wrong_account", provider: "google" })?.description).not.toMatch(/Third-party connections/);
  });

  it("names a Composio connect by its toolkit and does not promise sync (T-219)", () => {
    const ok = connectResultMessage({ connect: "ok", provider: "composio", toolkit: "gmail" });
    expect(ok).toMatchObject({ tone: "success", title: "Gmail via Composio connected" });
    expect(ok?.description).not.toMatch(/syncs in the background/);
    expect(ok?.description).toMatch(/stays in Composio until it is removed by hand/);
    expect(connectResultMessage({ connect: "ok", provider: "composio", toolkit: "googlecalendar" })?.title).toBe("Google Calendar via Composio connected");
    // an unknown toolkit is not echoed
    expect(connectResultMessage({ connect: "ok", provider: "composio", toolkit: "<script>" })?.title).toBe("Composio connected");
  });

  it("a refused Composio account tells the owner to remove it in the Composio dashboard", () => {
    const m = connectResultMessage({ connect: "account_refused", provider: "composio", toolkit: "gmail", notice: "remove_app_access" });
    expect(m?.tone).toBe("alert");
    expect(m?.title).toBe("Gmail via Composio account not accepted");
    expect(m?.description).toMatch(/mailbox list/);
    expect(m?.description).toMatch(/Composio dashboard/);
    expect(connectResultMessage({ connect: "account_refused", provider: "composio", toolkit: "gmail" })?.description).not.toMatch(/Composio dashboard/);
  });

  it("confirms a successful connect", () => {
    expect(connectResultMessage({ connect: "ok", provider: "google" })).toMatchObject({ tone: "success", title: "Google connected" });
  });

  it("covers every coarse callback code", () => {
    for (const code of ["denied", "invalid_state", "exchange_failed", "unavailable"]) {
      expect(connectResultMessage({ connect: code, provider: "quickbooks" })?.tone).toBe("alert");
    }
  });

  it("never puts URL text on the page: unknown codes, providers and notices are ignored", () => {
    expect(connectResultMessage({ connect: "<script>pwned</script>" })).toBeNull();
    const m = connectResultMessage({ connect: "denied", provider: "Evil Corp says call 555", notice: "call us" });
    expect(JSON.stringify(m)).not.toMatch(/Evil|555|call us/);
    expect(connectResultMessage({ connect: ["ok", "ok"] })).toBeNull();
  });

  it("adds the remove-access notice only where the server can send it", () => {
    expect(connectResultMessage({ connect: "exchange_failed", provider: "google", notice: "remove_app_access" })?.description).not.toMatch(/Third-party/);
    expect(connectResultMessage({ connect: "denied", provider: "google", notice: "remove_app_access" })?.description).not.toMatch(/Third-party/);
    expect(connectResultMessage({ connect: "unavailable", provider: "google", notice: "remove_app_access" })?.description).toMatch(/Third-party/);
  });
});

describe("connectResultFor", () => {
  const params = { connect: "account_refused", provider: "google" };
  it("shows the result to a user with connect rights in the lane", async () => {
    const g = { requireRole: async () => ({}) as never };
    expect(await connectResultFor(g, "PKG", params)).toMatchObject({ title: "Google account not accepted" });
  });
  it("shows nothing to other roles (a crafted link cannot reach them)", async () => {
    const g = { requireRole: async () => { throw new AuthError("forbidden"); } };
    expect(await connectResultFor(g, "PKG", params)).toBeNull();
  });
  it("does not check roles when there is nothing to show", async () => {
    const g = { requireRole: async () => { throw new Error("must not be called"); } };
    expect(await connectResultFor(g, "PKG", {})).toBeNull();
  });
  it("rethrows outages", async () => {
    const g = { requireRole: async () => { throw new Error("db down"); } };
    await expect(connectResultFor(g, "PKG", params)).rejects.toThrow("db down");
  });
});

describe("connectResultFor with an error code", () => {
  it("is shown only to the roles that can connect (a crafted link shows nobody else a banner)", async () => {
    const ok = { requireRole: async () => ({}) } as never;
    const denied = { requireRole: async () => { throw new AuthError("forbidden"); } } as never;
    expect((await connectResultFor(ok, "PKG", { error: "google_env" }))?.title).toMatch(/Google/);
    expect(await connectResultFor(denied, "PKG", { error: "google_env" })).toBeNull();
  });
});

describe("Microsoft results (T-066)", () => {
  it("wrong_tenant and admin_consent_required have fixed texts naming Microsoft; the remove-access notice follows wrong_tenant only when a grant existed", () => {
    const plain = connectResultMessage({ connect: "wrong_tenant", provider: "microsoft" });
    expect(plain).toMatchObject({ tone: "alert", title: "Microsoft organisation not accepted" });
    expect(plain?.description).not.toMatch(/app permissions/);
    const notice = connectResultMessage({ connect: "wrong_tenant", provider: "microsoft", notice: "remove_app_access" });
    expect(notice?.description).toMatch(/Microsoft account's app permissions page/);
    const consent = connectResultMessage({ connect: "admin_consent_required", provider: "microsoft" });
    expect(consent).toMatchObject({ tone: "alert", title: "Microsoft needs administrator approval" });
    expect(connectResultMessage({ connect: "admin_consent_required", provider: "microsoft", notice: "remove_app_access" })).toEqual(consent); // nothing was granted
  });
  it("account_refused and wrong_account name Microsoft and show the Microsoft remove-access text with the notice", () => {
    for (const connect of ["account_refused", "wrong_account", "unavailable"]) {
      const m = connectResultMessage({ connect, provider: "microsoft", notice: "remove_app_access" });
      expect(m?.description, connect).toMatch(/Microsoft account's app permissions page/);
      expect(m?.description, connect).not.toMatch(/Google/);
    }
    expect(connectResultMessage({ connect: "ok", provider: "microsoft" })?.title).toBe("Microsoft connected");
  });
  it("renders nothing from the query string: crafted provider and text are ignored", () => {
    const m = connectResultMessage({ connect: "wrong_tenant", provider: "microsoft", notice: "remove_app_access", text: "canary-ms-88", message: "canary-ms-88", tenant: "canary-ms-88" });
    expect(JSON.stringify(m)).not.toContain("canary-ms-88");
    expect(connectResultMessage({ connect: "wrong_tenant", provider: "<b>x</b>" })?.title).toBe("The provider organisation not accepted");
  });
});

describe("Microsoft results (T-257)", () => {
  const NOTE = /connects your mail and calendar, read-only\. It is not how anyone signs in to the portal/;
  it("the four refusals say it connects mail and calendar read-only and is not how anyone signs in; Google's text is unchanged", () => {
    for (const connect of ["admin_consent_required", "wrong_tenant", "wrong_account", "account_refused"]) {
      expect(connectResultMessage({ connect, provider: "microsoft" })?.description, connect).toMatch(NOTE);
      expect(connectResultMessage({ connect, provider: "google" })?.description ?? "", connect).not.toMatch(NOTE);
    }
  });
  it("the admin consent return has two fixed texts, only for Microsoft, and copies nothing from the URL", () => {
    expect(connectResultMessage({ connect: "consent_ok", provider: "microsoft" })).toMatchObject({ tone: "success", title: "Microsoft sent the administrator back" });
    expect(connectResultMessage({ connect: "consent_failed", provider: "microsoft" })).toMatchObject({ tone: "alert", title: "Administrator approval was not completed" });
    for (const provider of ["google", "quickbooks", undefined]) {
      for (const connect of ["consent_ok", "consent_failed", "disconnected"]) expect(connectResultMessage({ connect, provider }), `${connect} ${String(provider)}`).toBeNull();
    }
    const m = connectResultMessage({ connect: "consent_ok", provider: "microsoft", tenant: "canary-ms-5", scope: "canary-ms-5", admin_consent: "canary-ms-5", error_description: "canary-ms-5" });
    expect(JSON.stringify(m)).not.toContain("canary-ms-5");
  });
  it("the Disconnect result is fixed: stored access deleted, Microsoft may still list the app, where the person or administrator removes it; no link", () => {
    const m = connectResultMessage({ connect: "disconnected", provider: "microsoft", text: "canary-ms-6" });
    expect(m?.tone).toBe("success");
    expect(m?.description).toMatch(/stored in the portal was deleted/);
    expect(m?.description).toMatch(/Microsoft may still list the app/);
    expect(m?.description).toMatch(/Entra admin center \(Enterprise apps → the app → Permissions\)/);
    expect(JSON.stringify(m)).not.toMatch(/canary-ms-6|https?:\/\//);
  });
});
