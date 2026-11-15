// T-247: the lane's mail policy: allowed domains (fail closed when empty) and the optional exact mailbox list that narrows them.
import { describe, expect, it } from "vitest";
import { assertMailAccountAllowed, assertMailDomainsConfigured, domainOfAddress, mailAccountAllowed, readMailPolicy } from "./mail-policy";

const POLICY = { domains: ["example.test", "mail.example.test"], mailboxes: [] as string[] };

describe("domainOfAddress", () => {
  it("lower-cases the part after the last @ and refuses anything that is not local@domain", () => {
    expect(domainOfAddress("Ann@Example.TEST")).toBe("example.test");
    expect(domainOfAddress(" ann@example.test ")).toBe("example.test");
    for (const bad of ["", "ann", "@example.test", "ann@", "no at sign"]) expect(domainOfAddress(bad), bad).toBeNull();
  });
});

describe("mailAccountAllowed", () => {
  it("allows an address on a listed domain, case-insensitively, and nothing else", () => {
    expect(mailAccountAllowed(POLICY, "ann@example.test")).toBe(true);
    expect(mailAccountAllowed(POLICY, "ANN@MAIL.EXAMPLE.TEST")).toBe(true);
    expect(mailAccountAllowed(POLICY, "ann@elsewhere.test")).toBe(false);
  });
  it("is exact about the domain: a subdomain, a suffix or a look-alike is not the listed domain", () => {
    for (const a of ["ann@sub.example.test", "ann@example.test.evil.test", "ann@notexample.test", "ann@example.testx", "ann@evil.test@example.test.evil.test"]) {
      expect(mailAccountAllowed(POLICY, a), a).toBe(false);
    }
  });
  it("fails closed: an empty domain list allows nothing, even a listed mailbox", () => {
    expect(mailAccountAllowed({ domains: [], mailboxes: ["ann@example.test"] }, "ann@example.test")).toBe(false);
    expect(mailAccountAllowed({ domains: [], mailboxes: [] }, "ann@example.test")).toBe(false);
  });
  it("narrows with the exact list when it is not empty: the address must be on a listed domain AND on the list; the list never widens", () => {
    const p = { domains: ["example.test"], mailboxes: ["ann@example.test"] };
    expect(mailAccountAllowed(p, "ann@example.test")).toBe(true);
    expect(mailAccountAllowed(p, "Ann@Example.Test")).toBe(true);
    expect(mailAccountAllowed(p, "bob@example.test")).toBe(false);
    expect(mailAccountAllowed({ domains: ["example.test"], mailboxes: ["ann@elsewhere.test"] }, "ann@elsewhere.test")).toBe(false);
  });
});

describe("assert helpers", () => {
  it("throw forbidden with fixed text (never a config value)", () => {
    expect(() => assertMailAccountAllowed(POLICY, "ann@elsewhere.test")).toThrowError(expect.objectContaining({ info: expect.objectContaining({ kind: "forbidden", message: "This account's domain is not allowed for this lane" }) }) as Error);
    expect(() => assertMailAccountAllowed({ domains: ["example.test"], mailboxes: ["x@example.test"] }, "ann@example.test")).toThrowError(
      expect.objectContaining({ info: expect.objectContaining({ kind: "forbidden" }) }) as Error,
    );
    expect(() => assertMailAccountAllowed(POLICY, "ann@example.test")).not.toThrow();
    expect(() => assertMailDomainsConfigured([])).toThrowError(expect.objectContaining({ info: expect.objectContaining({ kind: "forbidden" }) }) as Error);
    expect(() => assertMailDomainsConfigured(["example.test"])).not.toThrow();
  });
});

describe("readMailPolicy", () => {
  it("reads both lists on every call and propagates a failure (fail closed)", async () => {
    let n = 0;
    const cfg = { mailDomains: async () => ((n += 1), ["example.test"]), mailboxes: async () => ["ann@example.test"] };
    expect(await readMailPolicy(cfg, "PKG")).toEqual({ domains: ["example.test"], mailboxes: ["ann@example.test"] });
    await readMailPolicy(cfg, "PKG");
    expect(n).toBe(2);
    await expect(readMailPolicy({ mailDomains: async () => { throw new Error("down"); }, mailboxes: async () => [] }, "PKG")).rejects.toThrow("down");
  });
});
