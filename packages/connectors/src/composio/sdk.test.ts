// T-219: the SDK adapter against the MSW fake of Composio's API (no real call; rule 10). Proves what actually goes over
// the wire: the project key is sent (explicit apiKey), the callback and user id reach `link`, toolkit versions are pinned,
// a refused slug never reaches the network, SDK errors become coarse ConnectorErrors, and nothing sensitive is logged.
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { createFakeComposio, type FakeComposio } from "../testing/msw/composio/handlers";
import { useMockServer } from "../testing/msw/index";
import { SecretValue } from "../vault/secret";
import { guardComposio } from "./port";
import { createSdkPort } from "./sdk";

const KEY = "ak_canary_composio_key_0123456789abcdef"; // synthetic canary
const USER = "11111111-1111-4111-8111-111111111111";
let fake: FakeComposio = createFakeComposio();
const server = useMockServer();

let logs: LogEntry[];
function port(timeoutMs?: number) {
  logs = [];
  return createSdkPort({ apiKey: () => new SecretValue(KEY), logger: createConnectorLogger({ sink: (e) => logs.push(e) }), ...(timeoutMs ? { timeoutMs } : {}) });
}

beforeEach(() => {
  fake = createFakeComposio();
  server.use(...fake.handlers);
});

describe("link", () => {
  it("creates the connected account link with the user, auth config and callback, and returns the id and consent url", async () => {
    const res = await port().link({ userId: USER, authConfigId: "ac_gmail_synthetic", callbackUrl: "https://app.example.test/api/connect/composio/callback?state=PKG.x" });
    expect(res).toEqual({ accountId: "ca_synthetic1", redirectUrl: "https://connect.composio.dev/link/lk_synthetic1" });
    expect(fake.lastLinkBody).toMatchObject({ auth_config_id: "ac_gmail_synthetic", user_id: USER, callback_url: "https://app.example.test/api/connect/composio/callback?state=PKG.x" });
    expect(fake.lastApiKey).toBe(KEY);
  });

  it("allows a reconnect when the user already has an ACTIVE account in the auth config (allowMultiple)", async () => {
    fake.accounts.set("ca_old", { id: "ca_old", status: "ACTIVE", toolkit: "gmail" });
    await expect(port().link({ userId: USER, authConfigId: "ac_gmail_synthetic", callbackUrl: "https://app.example.test/cb" })).resolves.toMatchObject({ accountId: "ca_synthetic1" });
  });
});

describe("getAccount", () => {
  it("returns status and toolkit only", async () => {
    fake.accounts.set("ca_a", { id: "ca_a", status: "EXPIRED", toolkit: "gmail" });
    expect(await port().getAccount("ca_a")).toEqual({ id: "ca_a", status: "EXPIRED", toolkitSlug: "gmail", isDisabled: false });
  });
  it("a missing account is not_found and carries no provider text", async () => {
    const err = await port().getAccount("ca_missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).info.kind).toBe("not_found");
  });
});

describe("execute", () => {
  it("executes an allow-listed read tool for the account and user, with the pinned toolkit version resolved by the SDK", async () => {
    fake.tools.set("GMAIL_GET_PROFILE", { successful: true, data: { emailAddress: "boss@example.test" } });
    const guarded = guardComposio(port());
    const res = await guarded.execute("gmail", "GMAIL_GET_PROFILE", { userId: USER, accountId: "ca_a", arguments: {} });
    expect(res).toEqual({ successful: true, data: { emailAddress: "boss@example.test" } });
    expect(fake.lastExecuteBody).toMatchObject({ connected_account_id: "ca_a", user_id: USER });
    expect(fake.requests).toContain("EXECUTE GMAIL_GET_PROFILE");
  });

  it("refuses a slug that is not on the allow-list BEFORE any network call", async () => {
    fake.tools.set("GMAIL_SEND_EMAIL", { successful: true, data: {} });
    const guarded = guardComposio(port());
    for (const slug of ["GMAIL_SEND_EMAIL", "GMAIL_DELETE_MESSAGE", "gmail_get_profile", "GMAIL_GET_PROFILE ", "GOOGLECALENDAR_EVENTS_LIST"]) {
      const err = await guarded.execute("gmail", slug, { userId: USER, accountId: "ca_a", arguments: {} }).catch((e: unknown) => e);
      expect(err, slug).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).info.kind).toBe("forbidden");
    }
    await expect(guarded.execute("notion" as never, "GMAIL_GET_PROFILE", { userId: USER, accountId: "ca_a", arguments: {} })).rejects.toBeInstanceOf(ConnectorError);
    expect(fake.requests).toEqual([]); // the network was never touched
  });

  it("refuses a user id that is not a Jarvis UUID (never an email, never 'default')", async () => {
    const guarded = guardComposio(port());
    for (const userId of ["default", "boss@example.test", ""]) {
      await expect(guarded.execute("gmail", "GMAIL_GET_PROFILE", { userId, accountId: "ca_a", arguments: {} })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    }
    expect(fake.requests).toEqual([]);
  });

  it("maps an unknown tool or a failure to a coarse error and never logs arguments, results or the key", async () => {
    const guarded = guardComposio(port());
    await expect(guarded.execute("gmail", "GMAIL_GET_PROFILE", { userId: USER, accountId: "ca_a", arguments: { q: "secret-subject-line" } })).rejects.toBeInstanceOf(ConnectorError);
    fake.tools.set("GMAIL_FETCH_EMAILS", { successful: true, data: { messages: [{ subject: "board salaries" }] } });
    await guarded.execute("gmail", "GMAIL_FETCH_EMAILS", { userId: USER, accountId: "ca_a", arguments: { q: "secret-subject-line" } });
    const text = JSON.stringify(logs);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("secret-subject-line");
    expect(text).not.toContain("board salaries");
    expect(logs.some((l) => l.event === "composio.execute")).toBe(true);
  });
});
