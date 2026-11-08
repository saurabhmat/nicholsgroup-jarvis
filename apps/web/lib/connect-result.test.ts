import { describe, expect, it } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { connectResultFor, connectResultMessage } from "./connect-result";

describe("connectResultMessage", () => {
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

  it("names a Composio connect by its toolkit and does not promise sync (T-219)", () => {
    const ok = connectResultMessage({ connect: "ok", provider: "composio", toolkit: "gmail" });
    expect(ok).toMatchObject({ tone: "success", title: "Gmail via Composio connected" });
    expect(ok?.description).not.toMatch(/syncs in the background/);
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
