// Webhook follow-up connection check (T-053): only an active or degraded QuickBooks connection of THIS lane is usable.
import { describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { createQuickbooksUsableCheck } from "./usable";

const CONN = "00000000-0000-4000-8000-000000000533";
const loaderOf = (result: { provider?: string; status?: string } | Error) =>
  ({ loadConnection: async () => { if (result instanceof Error) throw result; return result; } }) as never;

describe("createQuickbooksUsableCheck", () => {
  it("is true for active and degraded QuickBooks connections only", async () => {
    for (const [status, want] of [["active", true], ["degraded", true], ["reconnect_required", false], ["disconnected", false], ["pending", false], ["error", false]] as const) {
      expect(await createQuickbooksUsableCheck(loaderOf({ provider: "quickbooks", status }))("PKG", CONN), status).toBe(want);
    }
    expect(await createQuickbooksUsableCheck(loaderOf({ provider: "google", status: "active" }))("PKG", CONN)).toBe(false);
  });

  it("is false for a connection that is missing or belongs to another lane (not_found)", async () => {
    expect(await createQuickbooksUsableCheck(loaderOf(new ConnectorError({ kind: "not_found", message: "no" })))("PKG", CONN)).toBe(false);
  });

  it("rethrows infrastructure failures so the job retries instead of dropping the change", async () => {
    await expect(createQuickbooksUsableCheck(loaderOf(new Error("db down")))("PKG", CONN)).rejects.toThrow("db down");
    await expect(createQuickbooksUsableCheck(loaderOf(new ConnectorError({ kind: "transient", message: "x" })))("PKG", CONN)).rejects.toBeInstanceOf(ConnectorError);
  });
});
