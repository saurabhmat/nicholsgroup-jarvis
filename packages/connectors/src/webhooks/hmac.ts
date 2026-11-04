// A generic HMAC-SHA256 verifier (T-036): the signature is HMAC-SHA256(secret, signedData) in a header, hex or base64,
// optionally with a timestamp header that is part of the signed data (`<timestamp>.<body>`). It is complete and covered
// by tests, so a provider whose scheme is exactly this (Intuit: base64, header `intuit-signature`, no timestamp) can use
// it as is; providers with their own header grammar (Stripe's `t=...,v1=...`) write their own `WebhookVerifier`.
import { hmacSha256, safeEqual } from "./crypto";
import type { VerifyInput, VerifyResult, WebhookVerifier } from "./types";

export interface HmacVerifierOptions {
  /** Header holding the signature (case-insensitive). */
  signatureHeader: string;
  encoding: "hex" | "base64";
  /** Optional prefix before the signature in the header value, e.g. "sha256=". */
  prefix?: string;
  /** If set, this header carries Unix seconds and the signed data is `<timestamp>.<body>`. */
  timestampHeader?: string;
}

const UNIX_SECONDS = /^[0-9]{9,11}$/;

export function hmacSha256Verifier(options: HmacVerifierOptions): WebhookVerifier {
  const prefix = options.prefix ?? "";
  return {
    verify({ body, headers, secret }: VerifyInput): VerifyResult {
      const header = headers.get(options.signatureHeader);
      if (!header) return { ok: false, reason: "missing_signature" };
      if (!header.startsWith(prefix)) return { ok: false, reason: "malformed_signature" };
      const given = header.slice(prefix.length).trim();
      let signedAt: Date | null = null;
      let data: Uint8Array | string = body;
      if (options.timestampHeader) {
        const ts = headers.get(options.timestampHeader);
        if (!ts) return { ok: false, reason: "missing_timestamp" };
        if (!UNIX_SECONDS.test(ts)) return { ok: false, reason: "malformed_signature" };
        signedAt = new Date(Number(ts) * 1000);
        data = Buffer.concat([Buffer.from(`${ts}.`, "utf8"), body]);
      }
      const expected = hmacSha256(secret.reveal(), data).toString(options.encoding);
      // Hex is case-insensitive; base64 is not. Compare the canonical form.
      const candidate = options.encoding === "hex" ? given.toLowerCase() : given;
      return safeEqual(candidate, expected) ? { ok: true, signedAt } : { ok: false, reason: "bad_signature" };
    },
  };
}
