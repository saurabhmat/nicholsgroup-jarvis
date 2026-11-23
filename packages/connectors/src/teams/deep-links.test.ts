// Links that open Teams (T-284, spec 13): the exact documented shapes, built only from validated values, https, nothing from a message.
import { describe, expect, it } from "vitest";
import { callUrl, openChatUrl } from "./deep-links";

describe("callUrl", () => {
  it("one person: the documented audio call link; video adds withVideo=true", () => {
    expect(callUrl(["pat@teams.example.test"], false)).toBe("https://teams.microsoft.com/l/call/0/0?users=pat@teams.example.test");
    expect(callUrl(["pat@teams.example.test"], true)).toBe("https://teams.microsoft.com/l/call/0/0?users=pat@teams.example.test&withVideo=true");
  });
  it("a group: names joined by commas, in order", () => {
    expect(callUrl(["a@teams.example.test", "b.c@teams.example.test", "d+e@teams.example.test"], false)).toBe("https://teams.microsoft.com/l/call/0/0?users=a@teams.example.test,b.c@teams.example.test,d%2Be@teams.example.test");
  });
  it("a name that is not one plain address, an empty list, more than ten, a duplicate or an unnormalised name is refused (nothing is built)", () => {
    for (const bad of [["a@x.example.test,b@x.example.test"], ["a&withVideo=true@x.example.test"], ["a#b@x.example.test"], ["x#EXT#@x.example.test"], ["A@X.example.test"], ["a b@x.example.test"], [""], ["a@x.example.test/evil"], [], Array.from({ length: 11 }, (_, i) => `u${String(i)}@x.example.test`), ["a@x.example.test", "a@x.example.test"], [null as never], [{ toString: () => "a@x.example.test" } as never]]) {
      expect(() => callUrl(bad, false), JSON.stringify(bad)).toThrow();
    }
    expect(callUrl(Array.from({ length: 10 }, (_, i) => `u${String(i)}@x.example.test`), false).startsWith("https://teams.microsoft.com/l/call/0/0?users=")).toBe(true);
  });
  it("the result is always an https link on teams.microsoft.com with only the two documented parameters", () => {
    const u = new URL(callUrl(["pat@teams.example.test", "kim@teams.example.test"], true));
    expect(u.protocol).toBe("https:");
    expect(u.host).toBe("teams.microsoft.com");
    expect(u.pathname).toBe("/l/call/0/0");
    expect([...u.searchParams.keys()].sort()).toEqual(["users", "withVideo"]);
    expect(u.searchParams.get("users")).toBe("pat@teams.example.test,kim@teams.example.test");
  });
});

describe("openChatUrl", () => {
  const CHAT = "19:abc123def456@thread.v2";
  it("uses the chat's own link when it is https on teams.microsoft.com", () => {
    expect(openChatUrl(CHAT, `https://teams.microsoft.com/l/chat/${CHAT}/0?tenantId=t`)).toBe(`https://teams.microsoft.com/l/chat/${CHAT}/0?tenantId=t`);
  });
  it("otherwise builds the documented link from the chat id", () => {
    for (const web of [undefined, null, "", "https://evil.example.test/l/chat/x", "http://teams.microsoft.com/l/chat/x", "javascript:alert(1)", "https://teams.microsoft.com.evil.example.test/x", "https://user@teams.microsoft.com/x", "https://teams.cloud.microsoft/l/chat/x"]) {
      expect(openChatUrl(CHAT, web), String(web)).toBe(`https://teams.microsoft.com/l/chat/${CHAT}/conversations`);
    }
  });
  it("a chat id that is not a chat id builds nothing", () => {
    for (const bad of ["", "abc", "19:x/../y", "19:x?y=1", "19:x#z", `19:${"a".repeat(300)}`]) expect(() => openChatUrl(bad, null)).toThrow();
  });
});
