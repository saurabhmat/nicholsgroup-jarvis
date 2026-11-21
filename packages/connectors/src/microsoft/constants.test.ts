// Microsoft constants (T-256): host allow-list per cloud, rate buckets, tenant id shape, and the entry point staying server-only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { graphBucket, GRAPH_PATH, isCloudSupported, isGraphPath, isTenantId, loginOriginFor, MAX_CONCURRENT_PER_MAILBOX, microsoftHostsFor } from "./constants";

describe("hosts", () => {
  it("commercial: graph.microsoft.com and login.microsoftonline.com only", () => {
    expect([...microsoftHostsFor("commercial", "api")]).toEqual(["graph.microsoft.com"]);
    expect([...microsoftHostsFor("commercial", "token")]).toEqual(["login.microsoftonline.com"]);
  });
  it("gcc_high has no hosts (T-267) and is not supported; an unknown cloud has none either", () => {
    expect(microsoftHostsFor("gcc_high", "api").size).toBe(0);
    expect(microsoftHostsFor("gcc_high", "token").size).toBe(0);
    expect(microsoftHostsFor("nonsense" as never, "api").size).toBe(0);
    expect(isCloudSupported("gcc_high")).toBe(false);
    expect(isCloudSupported("commercial")).toBe(true);
    expect(() => loginOriginFor("gcc_high")).toThrow();
  });
});

describe("rate buckets and paths", () => {
  it("reads and writes have separate per-connection buckets (the write one ends in :write)", () => {
    const read = graphBucket("c1", "read");
    const write = graphBucket("c1", "write");
    expect(read.key).toBe("c1");
    expect(write.key).toBe("c1:write");
    expect(read.limit.requests).toBe(4);
    expect(write.limit.requests).toBeLessThan(read.limit.requests);
  });
  it("the per-mailbox cap is 4 (our own cap, not presented as Microsoft's)", () => {
    expect(MAX_CONCURRENT_PER_MAILBOX).toBe(4);
    expect(readFileSync(resolve(__dirname, "constants.ts"), "utf8")).toMatch(/OUR OWN client-side cap/);
  });
  it("only /me paths", () => {
    for (const ok of ["/me", "/me/messages", "/me/mailFolders/{id}/messages/delta", "/me/calendars/{id}/events"]) expect(GRAPH_PATH.test(ok), ok).toBe(true);
    for (const bad of ["/users/x", "/me2", "/meeting", "/", "/me?x=1", "/me/a b", "/me#x"]) expect(GRAPH_PATH.test(bad), bad).toBe(false);
  });
  it("the path rule refuses encoded dots, slashes and backslashes in any case, on its own", () => {
    for (const bad of ["/me/%2e%2e/users", "/me/%2E%2e/x", "/me/a%2fb", "/me/a%2Fb", "/me/a%5cb", "/me/a%5Cb", "/me/a\\b", "/me/%2e", "/me/{id}%2f"]) {
      expect(isGraphPath(bad), bad).toBe(false);
    }
    for (const ok of ["/me", "/me/messages/{id}", "/me/mailFolders/{id}/messages/delta"]) expect(isGraphPath(ok), ok).toBe(true);
  });
  it("tenant ids are lower-case UUIDs, never `common` or `organizations`", () => {
    expect(isTenantId("11111111-1111-4111-8111-111111111111")).toBe(true);
    for (const bad of ["common", "organizations", "consumers", "", "../x", "11111111-1111-4111-8111-11111111111G", null, 5]) expect(isTenantId(bad)).toBe(false);
  });
});

describe("the entry point", () => {
  it("imports server-only first", () => {
    expect(readFileSync(resolve(__dirname, "index.ts"), "utf8").startsWith('import "server-only";')).toBe(true);
  });
});
