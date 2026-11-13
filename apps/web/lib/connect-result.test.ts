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
    expect(m?.description).toMatch(/mailbox list/);
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
