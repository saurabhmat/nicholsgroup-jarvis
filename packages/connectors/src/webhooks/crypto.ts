// Small crypto helpers shared by webhook verifiers (T-036).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality for secrets and signatures. Both sides are hashed first so the comparison is over equal-length
 * buffers whatever the inputs are: neither the content nor the LENGTH of the expected value leaks through timing.
 */
export function safeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

export function hmacSha256(key: string, data: Uint8Array | string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Whether `signedAt` is within `toleranceSeconds` of `now`, in either direction (a far-future stamp is as bad as an old one). */
export function withinTolerance(signedAt: Date, now: Date, toleranceSeconds: number): boolean {
  const delta = Math.abs(now.getTime() - signedAt.getTime());
  return Number.isFinite(delta) && delta <= toleranceSeconds * 1000;
}
