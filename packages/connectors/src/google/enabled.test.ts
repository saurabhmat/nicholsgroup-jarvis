// T-255 (D-57): the Google OAuth start and callback are refused when `google` is not enabled for the lane (nothing stored, no code exchanged);
// a lane that enables it, or keeps the default, connects as before. Mocks only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createGoogleHarness } from "../testing/google-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeGoogle } from "../testing/msw/google/handlers";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());
const EXEC = "exec@pubkgroup.example.test";

function setup(enabled: (laneId: string) => Promise<boolean>) {
  const fake = createFakeGoogle();
  server.use(...fake.handlers);
  return { fake, h: createGoogleHarness({ fake, mailboxes: { PKG: [EXEC] }, googleEnabled: enabled }) };
}

describe("Google connect needs google in the lane's mail providers", () => {
  it("start is refused (forbidden) when google is not enabled: no state stored, no redirect", async () => {
    const { h } = setup(async (laneId) => laneId !== "PKG");
    await expect(h.connectViaCallback("PKG", { email: EXEC })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(h.states.size).toBe(0);
    expect(h.rows.size).toBe(0);
    expect(h.secrets.size).toBe(0);
  });

  it("the callback is refused when google was disabled after the start: no code exchanged, nothing stored", async () => {
    let on = true;
    const { fake, h } = setup(async () => on);
    const code = "synthetic-google-code-late-disable";
    fake.grant(code, { email: EXEC, scopes: ["https://www.googleapis.com/auth/gmail.readonly"], refresh: true });
    const url = await h.flow.start("google", "PKG", h.as("00000000-0000-4000-8000-0000000000a1"));
    on = false;
    const state = new URL(url).searchParams.get("state") ?? "";
    const result = await h.flow.callback("google", new URLSearchParams({ state, code }), h.as("00000000-0000-4000-8000-0000000000a1"));
    expect(result).toMatchObject({ ok: false, reason: "account_refused" });
    expect(fake.state.tokenRequests).toEqual([]);
    expect(h.secrets.size).toBe(0);
  });

  it("a lane where google is enabled connects as before; a failing check fails closed", async () => {
    const ok = setup(async () => true);
    expect((await ok.h.connectViaCallback("PKG", { email: EXEC })).result.ok).toBe(true);
    const broken = setup(async () => { throw new Error("config unreadable"); });
    await expect(broken.h.connectViaCallback("PKG", { email: EXEC })).rejects.toThrow();
    expect(broken.h.secrets.size).toBe(0);
  });
});
