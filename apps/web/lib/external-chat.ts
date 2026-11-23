// The two vendor chat sites the side menu opens (T-271). Plain module (no directive): constants only. Generic vendor addresses, no
// company setting. Nothing of the portal is sent to either site: the page is a link that opens the vendor's own interface, where the
// person signs in with their own account. Neither site allows itself to be shown inside another site's frame, so it opens in a new tab.
export const EXTERNAL_CHATS = {
  claude: { name: "Claude", vendor: "Anthropic", url: "https://claude.ai/" },
  chatgpt: { name: "ChatGPT", vendor: "OpenAI", url: "https://chatgpt.com/" },
} as const;

export type ExternalChatKey = keyof typeof EXTERNAL_CHATS;
