import { describe, expect, it } from "vitest";
import { gmailThreadUrl, isGmailThreadId } from "./gmail-url";

describe("gmailThreadUrl", () => {
  it("uses authuser with the URL-encoded mailbox and the hex thread id", () => {
    expect(gmailThreadUrl("robert@pubk.test", "18c2f0a1b2c3d4e5")).toBe("https://mail.google.com/mail/?authuser=robert%40pubk.test#all/18c2f0a1b2c3d4e5");
    expect(gmailThreadUrl("first+tag@pubk.test", "18c2f0a1b2c3d4e5")).toBe("https://mail.google.com/mail/?authuser=first%2Btag%40pubk.test#all/18c2f0a1b2c3d4e5");
  });
  it("is never the old /u/<address>/ shape", () => {
    expect(gmailThreadUrl("robert@pubk.test", "18c2f0a1b2c3d4e5")).not.toContain("/mail/u/");
  });
  it.each(["", "../x", "18C2F0A1B2C3D4E5", "zz", "18c2f0a1b2c3d4e5/../x", "18c2f0a1#x", "abc", "0".repeat(33), "18c2f0a1b2c3d4e5\n"])("no link for thread id %j", (id) => {
    expect(gmailThreadUrl("robert@pubk.test", id)).toBeNull();
    expect(isGmailThreadId(id)).toBe(false);
  });
  it.each([null, undefined, "", "robert", "a b@pubk.test", "robert@pubk.test#x", "ro/bert@pubk.test", "robert@pubk.test?x=1", "<r@pubk.test>"])("no link for mailbox %j", (m) => {
    expect(gmailThreadUrl(m, "18c2f0a1b2c3d4e5")).toBeNull();
  });
  it("no link without a thread id (a message id is not a thread id)", () => {
    expect(gmailThreadUrl("robert@pubk.test", null)).toBeNull();
    expect(gmailThreadUrl("robert@pubk.test", undefined)).toBeNull();
  });
});
