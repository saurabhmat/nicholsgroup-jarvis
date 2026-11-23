// The chat in the page address (T-283): one canonical key per chat; anything else is "no chat" and never reaches Graph.
import { describe, expect, it } from "vitest";
import { decodeChatKey, encodeChatKey, isChatId } from "./teams-chat-key";

describe("chat keys", () => {
  const ID = "19:abc123def456@thread.v2";
  it("round-trips a chat id and the key is url-safe", () => {
    const key = encodeChatKey(ID);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeChatKey(key)).toBe(ID);
    expect(decodeChatKey(encodeChatKey("19:uni_00112233@unq.gbl.spaces"))).toBe("19:uni_00112233@unq.gbl.spaces");
  });
  it("anything that is not exactly the key of a valid chat id decodes to null", () => {
    const b = (s: string) => Buffer.from(s).toString("base64url");
    for (const bad of [undefined, null, 5, "", "!!!", "a".repeat(400), b("not a chat"), b("19:x/../y"), b("19:x y"), b(`19:${"a".repeat(300)}`), b("18:abc@thread.v2"), `${encodeChatKey(ID)}=`, `${encodeChatKey(ID)}A`, b("19:x\u0000y")]) {
      expect(decodeChatKey(bad), String(bad)).toBeNull();
    }
  });
  it("refuses to encode a value that is not a chat id", () => {
    expect(() => encodeChatKey("../x")).toThrow();
    expect(isChatId("19:ok@thread.v2")).toBe(true);
    expect(isChatId(`19:${"a".repeat(198)}`)).toBe(false);
  });
});
