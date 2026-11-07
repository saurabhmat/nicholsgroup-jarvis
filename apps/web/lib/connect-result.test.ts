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
