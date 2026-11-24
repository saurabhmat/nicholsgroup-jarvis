// The pure parts of the inline-image proxy (T-285): the magic-byte sniff and the byte cap. (The address parser is exercised through the converter in message-html.test.ts.)
import { describe, expect, it } from "vitest";
import { HOSTED_IMAGE_MAX_BYTES, hostedRefFromSrc, sniffImage } from "./hosted-content";

const bytes = (...b: number[]) => Uint8Array.from(b);
const ascii = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));

describe("sniffImage", () => {
  it("recognises PNG, JPEG, GIF87a, GIF89a and WebP by their leading bytes only", () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImage(ascii("GIF87a\0\0"))).toBe("image/gif");
    expect(sniffImage(ascii("GIF89a\0\0"))).toBe("image/gif");
    expect(sniffImage(Uint8Array.from([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBPVP8 ")]))).toBe("image/webp");
  });

  it("refuses SVG, HTML, scripts, other RIFF files, truncated headers and an empty body", () => {
    for (const body of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<?xml version="1.0"?><svg/>',
      "<!doctype html><html><script>x()</script>",
      "GIF90a",
      "GIF8",
      "%PDF-1.7",
      "PK\u0003\u0004",
      "BM123456",
    ]) expect(sniffImage(ascii(body)), body).toBeNull();
    expect(sniffImage(Uint8Array.from([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVEfmt ")]))).toBeNull();
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    expect(sniffImage(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});

describe("limits and the address parser", () => {
  it("the cap is the documented 4 MB plus a small margin", () => {
    expect(HOSTED_IMAGE_MAX_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    expect(HOSTED_IMAGE_MAX_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024 + 256 * 1024);
  });
  it("an address that is not a string or not parseable gives nothing", () => {
    const scope = { kind: "chat" as const, chatId: "19:x@thread.v2" };
    for (const v of ["", "not a url", "https://", "//graph.microsoft.com/v1.0/x", "javascript:alert(1)", "https://graph.microsoft.com/v1.0/chats/19:x@thread.v2/messages/1/hostedContents/a b/$value", 5 as unknown as string]) expect(hostedRefFromSrc(v, scope, "1")).toBeNull();
  });
});
