// T-232: the gmail.compose scope exists only behind the lane policy flag. Default (PKG today): the connect is the
// unchanged read-only one and a compose grant is refused. With `write_actions_allowed` containing email_send or
// email_draft the consent also asks for gmail.compose, the callback accepts it, and the connection records
// `features.gmail_compose = true` (false when the owner unticked it, or on a reconnect without it). Mocks only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createGoogleHarness } from "../testing/google-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeGoogle, READ_SCOPES } from "../testing/msw/google/handlers";
import { GMAIL_COMPOSE, GOOGLE_SCOPES } from "./constants";
import { assertGrantedScopes } from "./provider";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});
const EXEC = "exec@pubkgroup.example.test";

function setup(composeLanes: string[]) {
  const fake = createFakeGoogle();
  server.use(...fake.handlers);
  return { fake, h: createGoogleHarness({ fake, mailboxes: { PKG: [EXEC] }, composeLanes }) };
}

describe("default (lane policy has no email write)", () => {
  it("asks for the three read-only scopes only and refuses a compose grant", async () => {
    const { h } = setup([]);
    const url = new URL(await h.flow.start("google", "PKG", h.as("00000000-0000-4000-8000-0000000000a1")));
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GOOGLE_SCOPES]);
    const { result } = await h.connectViaCallback("PKG", { email: EXEC, scopes: [...READ_SCOPES, GMAIL_COMPOSE] });
    expect(result.ok).toBe(false);
    expect(h.secrets.size).toBe(0);
  });

  it("records gmail_compose false on a normal read-only connect", async () => {
    const { h } = setup([]);
    const { result } = await h.connectViaCallback("PKG", { email: EXEC });
    expect(result.ok).toBe(true);
    expect([...h.rows.values()][0]?.features).toEqual({ gmail_compose: false });
  });
});

describe("lane policy allows email write", () => {
  it("adds gmail.compose to the consent URL", async () => {
    const { h } = setup(["PKG"]);
    const url = new URL(await h.flow.start("google", "PKG", h.as("00000000-0000-4000-8000-0000000000a1")));
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GOOGLE_SCOPES, GMAIL_COMPOSE]);
  });

  it("accepts the compose grant and records gmail_compose true", async () => {
    const { h } = setup(["PKG"]);
    const { result } = await h.connectViaCallback("PKG", { email: EXEC, scopes: [...READ_SCOPES, GMAIL_COMPOSE] });
    expect(result.ok).toBe(true);
    expect([...h.rows.values()][0]?.features).toEqual({ gmail_compose: true });
  });

  it("an unticked compose scope still connects read-only with gmail_compose false, and a reconnect clears an earlier true", async () => {
    const { h } = setup(["PKG"]);
    await h.connectViaCallback("PKG", { email: EXEC, scopes: [...READ_SCOPES, GMAIL_COMPOSE] });
    expect([...h.rows.values()][0]?.features).toEqual({ gmail_compose: true });
    const again = await h.connectViaCallback("PKG", { email: EXEC, scopes: READ_SCOPES });
    expect(again.result.ok).toBe(true);
    expect([...h.rows.values()][0]?.features).toEqual({ gmail_compose: false });
  });

  it("still refuses any other write scope", async () => {
    const { h } = setup(["PKG"]);
    const { result } = await h.connectViaCallback("PKG", { email: EXEC, scopes: [...READ_SCOPES, "https://www.googleapis.com/auth/gmail.modify"] });
    expect(result.ok).toBe(false);
  });

  it("another lane without the flag is unaffected (per lane, not global)", async () => {
    const { h } = setup(["APK"]);
    const url = new URL(await h.flow.start("google", "PKG", h.as("00000000-0000-4000-8000-0000000000a1")));
    expect(url.searchParams.get("scope")).not.toContain("gmail.compose");
  });
});

describe("assertGrantedScopes", () => {
  it("refuses compose unless allowed, reports it when allowed", () => {
    const withCompose = [...READ_SCOPES, GMAIL_COMPOSE].join(" ");
    expect(() => assertGrantedScopes(withCompose)).toThrow();
    expect(assertGrantedScopes(withCompose, true)).toEqual({ compose: true });
    expect(assertGrantedScopes(READ_SCOPES.join(" "), true)).toEqual({ compose: false });
  });
});
