// Inline images of a Teams message (T-285; spec 8.5, vendor facts A1 and B): the PURE parts, with no server-only import and no network.
//   - `hostedRefFromSrc`: reads the address an `<img>` carries ONLY to find out whether it names a hosted content of THE SAME message (a chat message, or a root post of a channel), and returns
//     the hosted content's id, a validated string. It never returns, keeps or fetches a URL: anything else (another host, another message, a query, a user name, a port, a path that is not
//     exactly the documented one) yields null and the picture stays a neutral placeholder. Nothing here can make the server or the browser load an address from message content (no SSRF).
//   - `sniffImage`: decides the type of the bytes from their first bytes (PNG, JPEG, GIF, WebP). Microsoft's own content type is never trusted or echoed; SVG and everything else is refused.
//   - the byte cap: the documented maximum of hosted content is 4 MB (vendor facts A2) plus a small margin.
import { TEAMS_PARAM_FORMATS } from "./constants";

/** Microsoft documents 4 MB as the maximum size of hosted content [A2]; a small margin on top. A larger body is refused and the read is stopped. */
export const HOSTED_IMAGE_MAX_BYTES = 4 * 1024 * 1024 + 64 * 1024;

/** The message whose body is being converted: a hosted content is only accepted when its address names exactly this message. */
export type HostedScope = { kind: "chat"; chatId: string } | { kind: "channel"; teamId: string; channelId: string };
/** What identifies one hosted content of one message: the only things an image route accepts. */
export type HostedTarget = ({ kind: "chat"; chatId: string } | { kind: "channel"; teamId: string; channelId: string }) & { messageId: string; hostedId: string };

const GRAPH_HOST = "graph.microsoft.com";
const GRAPH_PREFIX = "v1.0";

function segment(raw: string): string | null {
  try {
    const v = decodeURIComponent(raw);
    return v.includes("/") || v.includes("\\") ? null : v;
  } catch {
    return null;
  }
}

const same = (a: string | undefined, b: string): boolean => a !== undefined && a === b;

/**
 * The hosted content an `<img src>` names, when it is exactly the documented Graph address of a hosted content of the message `messageId` inside `scope`:
 *   https://graph.microsoft.com/v1.0/chats/<chatId>/messages/<messageId>/hostedContents/<hostedId>/$value
 *   https://graph.microsoft.com/v1.0/teams/<teamId>/channels/<channelId>/messages/<messageId>/hostedContents/<hostedId>/$value
 * Returns the hosted content id (validated against the id format), or null.
 */
export function hostedRefFromSrc(src: string, scope: HostedScope, messageId: string): string | null {
  if (typeof src !== "string" || src.length > 2048 || !URL.canParse(src)) return null;
  if (/[\u0000- \u007f-\u009f]/.test(src.trim())) return null;
  const u = new URL(src.trim());
  if (u.protocol !== "https:" || u.hostname !== GRAPH_HOST || u.port !== "" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return null;
  const parts = u.pathname.split("/");
  if (parts[0] !== "" || parts[1] !== GRAPH_PREFIX) return null;
  const s = parts.slice(2).map((p) => segment(p));
  if (s.some((p) => p === null || p === "")) return null;
  const v = s as string[];
  let hostedId: string | undefined;
  if (scope.kind === "chat") {
    // chats/<chat>/messages/<message>/hostedContents/<id>/$value
    if (v.length !== 7 || v[0] !== "chats" || v[2] !== "messages" || v[4] !== "hostedContents" || v[6] !== "$value") return null;
    if (!same(v[1], scope.chatId) || !same(v[3], messageId)) return null;
    hostedId = v[5];
  } else {
    // teams/<team>/channels/<channel>/messages/<message>/hostedContents/<id>/$value
    if (v.length !== 9 || v[0] !== "teams" || v[2] !== "channels" || v[4] !== "messages" || v[6] !== "hostedContents" || v[8] !== "$value") return null;
    if (!same(v[1]?.toLowerCase(), scope.teamId.toLowerCase()) || !same(v[3], scope.channelId) || !same(v[5], messageId)) return null;
    hostedId = v[7];
  }
  const format = TEAMS_PARAM_FORMATS.hostedId as RegExp;
  return hostedId !== undefined && format.test(hostedId) ? hostedId : null;
}

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The type of an image from its leading bytes; null for anything that is not a PNG, JPEG, GIF or WebP (SVG, HTML, an archive, an empty body). */
export function sniffImage(b: Uint8Array): ImageType | null {
  const at = (i: number) => b[i];
  if (b.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (b.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 && (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61) return "image/gif";
  if (b.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return null;
}
