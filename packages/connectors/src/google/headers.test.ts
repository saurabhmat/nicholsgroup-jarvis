// Header and MIME parsing (T-063): defensive on hostile input, never throws, bounded.
import { describe, expect, it } from "vitest";
import { cleanText, decodeEncodedWords, parseAddressList, parseMailbox, parseSubject } from "./headers";
import { cut, extractText, htmlToText, type GmailPart } from "./mime";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("addresses", () => {
  it("parses names, quotes, commas in names and lists", () => {
    expect(parseMailbox('"Doe, Jane" <Jane@Example.test>')).toEqual({ address: "jane@example.test", name: "Doe, Jane" });
    expect(parseMailbox("bob@example.test")).toEqual({ address: "bob@example.test" });
    expect(parseMailbox("Bob <bob@example.test>")).toEqual({ address: "bob@example.test", name: "Bob" });
    expect(parseAddressList('"A, B" <a@example.test>, c@example.test; D <d@example.test>').map((x) => x.address)).toEqual(["a@example.test", "c@example.test", "d@example.test"]);
  });
  it("drops what is not an address and bounds the list", () => {
    expect(parseMailbox("undisclosed-recipients:;")).toBeNull();
    expect(parseMailbox("<>")).toBeNull();
    expect(parseMailbox("a b@example.test")).toBeNull();
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList(Array.from({ length: 500 }, (_v, i) => `u${String(i)}@example.test`).join(","), 200)).toHaveLength(200);
  });
  it("decodes RFC 2047 names and strips control and bidi characters", () => {
    expect(decodeEncodedWords("=?UTF-8?B?SsO8cmdlbg==?=")).toBe("Jürgen");
    expect(decodeEncodedWords("=?iso-8859-1?Q?Andr=E9_X?=")).toBe("André X");
    expect(decodeEncodedWords("=?utf-8?B?SGVs?= =?utf-8?B?bG8=?=")).toBe("Hello");
    expect(parseMailbox("=?UTF-8?B?SsO8cmdlbg==?= <j@example.test>")?.name).toBe("Jürgen");
    expect(cleanText("a\u202Eb\u0007c\r\nd")).toBe("a b c d");
    expect(parseSubject("   ")).toBeNull();
    expect(parseSubject(undefined)).toBeNull();
    expect(parseSubject("x".repeat(3000))?.length).toBe(998);
  });
});

describe("hostile input stays linear", () => {
  const fast = (f: () => unknown) => {
    const t = Date.now();
    f();
    return Date.now() - t;
  };
  it("100 KB of unclosed parentheses, angle brackets and quotes in an address header parses in well under a second", () => {
    for (const bad of ["(".repeat(100_000), "<".repeat(100_000), '"'.repeat(100_000), `x${"(a".repeat(50_000)}`, `${"<a".repeat(50_000)}@`]) {
      expect(fast(() => parseAddressList(bad)), bad.slice(0, 4)).toBeLessThan(1000);
      expect(fast(() => parseMailbox(bad))).toBeLessThan(1000);
      expect(fast(() => parseSubject(bad))).toBeLessThan(1000);
    }
  });
  it("caps raw header text before parsing: To/Cc 16 KB, From and Subject 2 KB", () => {
    const addrs = Array.from({ length: 3000 }, (_v, i) => `u${String(i)}@example.test`).join(", ");
    expect(parseAddressList(addrs, 5000).length).toBeLessThan(1000);
    expect(parseAddressList(`${"x".repeat(2100)} <late@example.test>`, 1, 2048)).toEqual([]);
    expect(parseSubject(`${" ".repeat(2048)}tail`)).toBeNull();
  });
  it("1 MB of '<a' or '<head ' converts in under a second and an unclosed block drops the rest", () => {
    for (const unit of ["<a", "<head ", "<script ", "<!--", "&#x", "<style>"]) {
      const html = unit.repeat(Math.ceil(1_000_000 / unit.length));
      expect(fast(() => htmlToText(html)), unit).toBeLessThan(1000);
    }
    expect(htmlToText("keep<head>secret")).toBe("keep");
    expect(htmlToText("a<!-- never closed b")).toBe("a");
    expect(htmlToText("a<SCRIPT type=x>evil()</Script>b")).toBe("a b");
  });
  it("a 1 MB HTML part is cut before conversion and the total decoded bytes across parts are bounded", () => {
    const big = (s: string) => ({ mimeType: "text/html", body: { data: Buffer.from(s.repeat(Math.ceil(1_000_000 / s.length)), "utf8").toString("base64url") } });
    const t = Date.now();
    const r = extractText({ mimeType: "multipart/mixed", parts: [big("<a"), big("<head "), big("<p>word </p>")] }, 100);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(r.text.length).toBeLessThanOrEqual(100);
    const parts = Array.from({ length: 20 }, () => ({ mimeType: "text/plain", body: { data: Buffer.from("y".repeat(500_000), "utf8").toString("base64url") } }));
    const many = extractText({ mimeType: "multipart/mixed", parts }, 1_000_000);
    expect(many.text.replace(/\n/g, "").length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});

describe("MIME text", () => {
  const plain = (s: string, charset = "UTF-8"): GmailPart => ({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: `text/plain; charset=${charset}` }], body: { data: b64(s) } });
  it("prefers text/plain, joins parts, skips attachments and non-text parts", () => {
    const tree: GmailPart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "multipart/alternative", parts: [plain("hello plain"), { mimeType: "text/html", body: { data: b64("<p>hello html</p>") } }] },
        { mimeType: "text/plain", filename: "a.txt", body: { attachmentId: "x", data: b64("ATTACHMENT") } },
        { mimeType: "image/png", body: { data: b64("PNG") } },
      ],
    };
    expect(extractText(tree, 1000)).toEqual({ text: "hello plain", contentType: "text/plain", truncated: false });
  });
  it("falls back to HTML converted to text", () => {
    const tree: GmailPart = { mimeType: "text/html", body: { data: b64("<html><head><style>p{}</style></head><body><p>One &amp; two</p><script>evil()</script><br>Three&nbsp;&#x41;</body></html>") } };
    expect(extractText(tree, 1000).text).toBe("One & two\n\nThree A");
  });
  it("decodes the declared charset and tolerates an unknown one", () => {
    const latin = { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }], body: { data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64url") } };
    expect(extractText(latin, 100).text).toBe("café");
    expect(extractText(plain("ok", "x-nonsense"), 100).text).toBe("ok");
  });
  it("cuts at maxChars without splitting a surrogate pair, and bounds depth", () => {
    expect(cut("ab😀cd", 3)).toEqual({ text: "ab", truncated: true });
    expect(extractText(plain("abcdef"), 3)).toMatchObject({ text: "abc", truncated: true });
    let deep: GmailPart = plain("deep text");
    for (let i = 0; i < 30; i++) deep = { mimeType: "multipart/mixed", parts: [deep] };
    expect(extractText(deep, 100).text).toBe("");
    expect(htmlToText("<p>a</p>".repeat(10))).toContain("a");
    expect(extractText({ mimeType: "multipart/mixed" }, 10).text).toBe("");
  });
});
