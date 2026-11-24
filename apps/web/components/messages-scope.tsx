"use client";
// Messages: what the browser's address says about the screen (T-296; spec docs/specs/messages.md 11, 22.6). The chat list is drawn ONCE by the Messages layout (app/[laneId]/messages/layout.tsx)
// and stays mounted while only `?conn=` / `?chat=` / `?tab=` change, so it cannot know the open chat, the open tab or whether a conversation has the screen from the server: this client scope reads them
// from the address (`useSearchParams`) and hands them down (a context) and to the CSS (data attributes the panes' classes read). Nothing here is read from Microsoft or stored; the address holds a
// chat KEY (an encoded id the page validates again) and a connection id (a name, never a permission: the page and every route re-check it).
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";
import { laneHref } from "@nichols/ui";
import { viewOf, type MessagesTab, type MessagesView } from "@/lib/messages-view-state";

const Ctx = createContext<MessagesView | null>(null);
/** The screen state, or null outside a Messages scope (a test, a failure card). */
export const useMessagesView = (): MessagesView | null => useContext(Ctx);

/**
 * Wraps the connected Messages screen: sets `data-view` / `data-open` (the panes' classes read them through `group-data-[...]/messages`) and provides the state. `className` is the column the page is.
 */
export function MessagesScope({ chatConns, className, children }: { chatConns: readonly string[]; className?: string; children: ReactNode }) {
  const v = viewOf(useSearchParams(), chatConns);
  return (
    <Ctx.Provider value={v}>
      <div data-testid="messages-scope" data-tab={v.tab} data-view={v.view} data-open={v.open ? "true" : "false"} className={`group/messages ${className ?? ""}`}>
        {children}
      </div>
    </Ctx.Provider>
  );
}

/** Shows `chats` on the Chats tab and `channels` on the Channels tab: both are drawn by the server (the layout cannot read the tab), only the one for the tab in the address is mounted. */
export function ByTab({ chats, channels }: { chats: ReactNode; channels: ReactNode }) {
  const v = useMessagesView();
  return <>{v?.tab === "channels" ? channels : chats}</>;
}

/** Chats | Channels (T-291). Plain links, so a tab is a stable address; hidden on a phone while a conversation has the screen. */
export function MessagesTabs({ laneId, tab, hideOnPhone }: { laneId: string; tab: MessagesTab; hideOnPhone: boolean }) {
  const base = laneHref(laneId, "messages");
  const item = (id: MessagesTab, label: string, href: string) => (
    <Link
      key={id}
      href={href}
      scroll={false}
      aria-current={tab === id ? "page" : undefined}
      data-testid={`tab-${id}`}
      className={`inline-flex min-h-11 items-center rounded-control border px-4 text-body font-medium ${tab === id ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Messages" data-testid="messages-tabs" className={`flex gap-2 ${hideOnPhone ? "hidden lg:flex" : ""}`}>
      {item("chats", "Chats", base)}
      {item("channels", "Channels", `${base}?tab=channels`)}
    </nav>
  );
}

/** The tabs, with the active one and the phone rule taken from the address. */
export function LiveTabs({ laneId }: { laneId: string }) {
  const v = useMessagesView();
  return <MessagesTabs laneId={laneId} tab={v?.tab ?? "chats"} hideOnPhone={v?.open ?? false} />;
}
