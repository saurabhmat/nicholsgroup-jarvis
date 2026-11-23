// @vitest-environment jsdom
// T-271: the Claude and ChatGPT pages open the vendor's own site in a new tab; nothing of the portal is passed along.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EXTERNAL_CHATS } from "@/lib/external-chat";
import { ExternalChatView } from "./external-chat-page";

afterEach(cleanup);

describe("external chat pages", () => {
  it.each([
    ["claude", "Claude", "https://claude.ai/"],
    ["chatgpt", "ChatGPT", "https://chatgpt.com/"],
  ] as const)("%s: a titled page with one link that opens the vendor site safely in a new tab", (key, name, url) => {
    render(<ExternalChatView chat={key} laneName="Synthetic Co" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(name);
    const link = screen.getByRole("link", { name: new RegExp(`^Open ${name}`) });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("(opens in a new tab)");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("the addresses are fixed https vendor addresses with no query (no lane, user or portal data in the link)", () => {
    for (const c of Object.values(EXTERNAL_CHATS)) {
      const u = new URL(c.url);
      expect(u.protocol).toBe("https:");
      expect(u.search + u.hash).toBe("");
      expect(u.pathname).toBe("/");
    }
    expect(Object.keys(EXTERNAL_CHATS).sort()).toEqual(["chatgpt", "claude"]);
  });
});
