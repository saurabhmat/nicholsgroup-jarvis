// PKCE (RFC 7636, S256) and the `state` parameter for the OAuth connect flow (T-035). The state carries the lane in
// clear (`PKG.<random>`) so the callback knows which lane to authorize before it looks the state up; the random part
// is what makes it unguessable, and only its SHA-256 is stored.
import { createHash, randomBytes } from "node:crypto";

const LANE_ID = /^[A-Z]{1,8}$/;
const STATE = /^([A-Z]{1,8})\.([A-Za-z0-9_-]{43})$/;

/** 32 random bytes, base64url (43 characters): a valid PKCE verifier. */
export function newCodeVerifier(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString("base64url");
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function newState(laneId: string, random: (n: number) => Buffer = randomBytes): string {
  if (!LANE_ID.test(laneId)) throw new TypeError("invalid lane");
  return `${laneId}.${random(32).toString("base64url")}`;
}

/** The lane named in a state value, or null when the value is not one this flow produced. */
export function laneOfState(state: unknown): string | null {
  if (typeof state !== "string") return null;
  return STATE.exec(state)?.[1] ?? null;
}

export function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}
