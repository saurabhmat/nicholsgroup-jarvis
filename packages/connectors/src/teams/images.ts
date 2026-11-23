// The inline-image reader (T-285; spec 8.5, vendor facts A1 and B): the bytes of ONE hosted content of ONE message, for the portal's own image route and nothing else.
//   - the request is a fixed template (`.../hostedContents/{hostedId}/$value`) with validated ids, through the guarded read client (the guard checks the owner, the lane and the feature `chat_read`
//     or `channels_read`); no address from message content is ever used (the converter handed over an id, never a URL);
//   - the body is read as raw bytes and cut at the cap WHILE streaming (a longer one stops the read, so nothing large is held);
//   - the TYPE is decided here from the first bytes (PNG, JPEG, GIF, WebP). Microsoft's own content type is not looked at, so a wrong or lying header changes nothing, and SVG, HTML and every other
//     body are refused;
//   - nothing is stored, cached or logged (no log call in this file); the bytes live in the memory of the one request.
import type { LaneId } from "@nichols/core";
import { isConnectorError } from "../contract/errors";
import type { TeamsApi } from "./api";
import { HOSTED_IMAGE_MAX_BYTES, sniffImage, type HostedTarget, type ImageType } from "./hosted-content";

export type HostedImage = { ok: true; bytes: Uint8Array; contentType: ImageType } | { ok: false; reason: "too_large" | "not_image" };

/** A picture may take a little longer than a page of text; still bounded. */
const IMAGE_TIMEOUT_MS = 15_000;

export function createTeamsImageReader(deps: { api: TeamsApi }) {
  return {
    async fetchHostedImage(laneId: LaneId, conn: unknown, userId: string, target: HostedTarget): Promise<HostedImage> {
      const base = { actor: { kind: "user" as const, userId }, retry: false, timeoutMs: IMAGE_TIMEOUT_MS, responseType: "bytes" as const, maxBytes: HOSTED_IMAGE_MAX_BYTES };
      try {
        const res =
          target.kind === "chat"
            ? await deps.api.get<unknown>(laneId, conn, { ...base, path: "/chats/{chatId}/messages/{messageId}/hostedContents/{hostedId}/$value", params: { chatId: target.chatId, messageId: target.messageId, hostedId: target.hostedId } })
            : await deps.api.get<unknown>(laneId, conn, {
                ...base,
                path: "/teams/{teamId}/channels/{channelId}/messages/{messageId}/hostedContents/{hostedId}/$value",
                params: { teamId: target.teamId, channelId: target.channelId, messageId: target.messageId, hostedId: target.hostedId },
              });
        const data = res.data;
        if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > HOSTED_IMAGE_MAX_BYTES) return { ok: false, reason: "not_image" };
        const contentType = sniffImage(data);
        return contentType === null ? { ok: false, reason: "not_image" } : { ok: true, bytes: data, contentType };
      } catch (e) {
        // A body over the cap stops the read and leaves the shared client as a `provider_error` on a 200 answer (the Graph error map then replaces its text); with raw bytes there is no other way
        // for a 2xx answer to fail, so that is "too large". Every other failure (404, 403, 429, 5xx, a timeout) keeps its own kind for the caller to map.
        if (isConnectorError(e) && e.info.kind === "provider_error" && e.info.http_status === 200) return { ok: false, reason: "too_large" };
        throw e;
      }
    },
  };
}

export type TeamsImageReader = ReturnType<typeof createTeamsImageReader>;
