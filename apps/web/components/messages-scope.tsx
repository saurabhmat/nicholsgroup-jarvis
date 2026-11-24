"use client";
// Messages: what the browser's address says about the screen (T-296; spec docs/specs/messages.md 11, 22.6). The chat list is drawn ONCE by the Messages layout (app/[laneId]/messages/layout.tsx)
// and stays mounted while only `?conn=` / `?chat=` / `?tab=` change, so it cannot know the open chat, the open tab or whether a conversation has the screen from the server: this client scope reads them
// from the address (`useSearchParams`) and hands them down (a context) and to the CSS (data attributes the panes' classes read). Nothing here is read from Microsoft or stored; the address holds a
// chat KEY (an encoded id the page validates again) and a connection id (a name, never a permission: the page and every route re-check it).
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { laneHref } from "@nichols/ui";
import { viewOf, type MessagesTab, type MessagesView } from "@/lib/messages-view-state";

/** The visual viewport must be shorter than the window by more than this (px) to count as "the keyboard is up" (a collapsing address bar is about 50 px; a keyboard is 250 or more). */
export const KEYBOARD_MIN_PX = 120;
/** A field a keyboard opens for: a text-like input, a textarea, a select or an editable region. */
function isTextEntry(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !["button", "submit", "reset", "checkbox", "radio", "range", "file", "image", "color"].includes(t.type);
  return t.isContentEditable;
}

const Ctx = createContext<MessagesView | null>(null);
/** The screen state, or null outside a Messages scope (a test, a failure card). */
export const useMessagesView = (): MessagesView | null => useContext(Ctx);

/**
 * Wraps the connected Messages screen: sets `data-view` / `data-open` (the panes' classes read them through `group-data-[...]/messages`) and provides the state. `className` is the column the page is.
 */
export function MessagesScope({ chatConns, className, children }: { chatConns: readonly string[]; className?: string; children: ReactNode }) {
  const v = viewOf(useSearchParams(), chatConns);
  const box = useRef<HTMLDivElement>(null);
  // PHONE HEIGHT (T-297 review M2). Below `lg` the conversation pane is one screen: its bottom edge must sit exactly above the fixed tab bar, with the header and back control visible and the
  // messages scrolling inside it. The chrome above it (the navy header band, the main area's padding, the page header, the notice lines) has no fixed size, so the pane's height is measured here
  // (after layout, never while rendering): window height - the tab bar's height - the pane column's distance from the top of the page. It is handed down as the CSS variable `--pane-h`, which
  // the pane's classes read (their fallback is the old calc). From `lg` the panes are sized by the flex chain and the variable is unused.
  // THE ON-SCREEN KEYBOARD (T-288, carried from the T-296 re-check). On iOS the keyboard shrinks only the VISUAL viewport (`window.innerHeight` keeps its full value) and covers the fixed tab bar. While a text
  // input INSIDE this scope has the focus and the visual viewport is clearly shorter than the window (more than KEYBOARD_MIN_PX), the pane ends at the bottom of the visual viewport instead:
  //   h = visualViewport.height + visualViewport.offsetTop - (the column's top in the window)      (the tab bar is left out of the sum: the keyboard is over it)
  // so the Send box sits just above the keyboard. On blur (or when the keyboard goes) the sum above, with the tab bar, applies again. The visual viewport's `scroll` event is listened to as well: iOS moves
  // `offsetTop` when it scrolls the focused field into view.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    let editing = false; // a text input inside the scope has the focus
    const measure = () => {
      const col = el.querySelector<HTMLElement>('[data-testid="messages-right"]');
      const bar = document.querySelector<HTMLElement>('[data-slot="tab-bar"]');
      if (!col || window.matchMedia?.("(min-width: 1024px)")?.matches) {
        el.style.removeProperty("--pane-h");
        return;
      }
      const rect = col.getBoundingClientRect();
      const vv = window.visualViewport;
      let h: number;
      if (editing && vv && window.innerHeight - vv.height > KEYBOARD_MIN_PX) h = Math.floor(vv.height + vv.offsetTop - rect.top);
      else h = Math.floor(window.innerHeight - (bar?.getBoundingClientRect().height ?? 0) - (rect.top + window.scrollY));
      el.style.setProperty("--pane-h", `${Math.max(h, 256)}px`);
    };
    const focusIn = (e: FocusEvent) => {
      editing = isTextEntry(e.target);
      measure();
    };
    const focusOut = (e: FocusEvent) => {
      // moving from one field of the pane to another keeps the keyboard up; anything else ends the editing
      editing = isTextEntry(e.relatedTarget) && el.contains(e.relatedTarget as Node);
      measure();
    };
    measure();
    el.addEventListener("focusin", focusIn);
    el.addEventListener("focusout", focusOut);
    window.addEventListener("resize", measure);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", measure);
    vv?.addEventListener("scroll", measure);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(document.body);
    return () => {
      el.removeEventListener("focusin", focusIn);
      el.removeEventListener("focusout", focusOut);
      window.removeEventListener("resize", measure);
      vv?.removeEventListener("resize", measure);
      vv?.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [v.view, v.open, v.chatKey]);
  return (
    <Ctx.Provider value={v}>
      <div ref={box} data-testid="messages-scope" data-tab={v.tab} data-view={v.view} data-open={v.open ? "true" : "false"} className={`group/messages ${className ?? ""}`}>
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
