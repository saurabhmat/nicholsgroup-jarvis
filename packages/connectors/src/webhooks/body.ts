// Reading the request body for a webhook (T-036): the raw bytes, capped while streaming (a lying or missing
// Content-Length does not get past the cap), and the content-type check.

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const HARD_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The media type of a Content-Type header: lowercase, parameters dropped; "" when absent. */
export function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";").at(0)?.trim().toLowerCase() ?? "";
}

export type BodyRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "unreadable" };

/**
 * Reads the raw body once, as bytes, before anything parses it (signatures cover the exact bytes). Stops reading as soon
 * as the cap is crossed. `Content-Length` over the cap is refused before a byte is read.
 */
export async function readRawBody(request: Request, maxBytes: number): Promise<BodyRead> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]{1,12}$/.test(declared) || Number(declared) > maxBytes)) {
    return { ok: false, reason: "too_large" };
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}
