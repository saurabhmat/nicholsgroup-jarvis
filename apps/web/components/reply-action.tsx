"use client";
// The "Reply" action on a Needs-your-attention item (T-234 part 3). For the OWNER it opens the Reply drawer (reply-drawer.tsx):
// a side drawer on a desktop, a full-screen sheet on a phone. Other roles cannot send, so for them Reply is a plain link to the
// thread in Jarvis (the same as "Open"). Same props as before (`target`), plus `canReply`, so the attention list is unchanged.
// Coming back from the authenticator step (`?reply=<message id>`) the drawer for that message reopens by itself.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@nichols/ui";
import { inboxHref } from "@/lib/inbox-links";
import { openDrawer } from "@/lib/reply-draft-store";
import { useHomeScope } from "./home-scope";
import { ReplyDrawer } from "./reply-drawer";

export type ReplyTarget = {
  laneId: string;
  connectionId: string;
  messageId: string;
  threadKey: string;
  /** The T-231d draft's email.send proposal, when the briefing prepared one (the drawer loads the pending proposal itself). */
  proposalId: string | null;
};

export function ReplyAction({ target, canReply = false }: { target: ReplyTarget; canReply?: boolean }) {
  if (!canReply) {
    return (
      <Link href={inboxHref(target.laneId, target.messageId)} data-testid="attention-reply" data-has-draft={target.proposalId ? "true" : "false"} className={buttonVariants({ variant: "outline", size: "sm" })}>
        Reply
      </Link>
    );
  }
  return <ReplyTrigger target={target} />;
}

/** This page load is a reload or back/forward (not a fresh navigation). Unknown counts as fresh. */
function reloaded(): boolean {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav?.type === "reload" || nav?.type === "back_forward";
  } catch {
    return false;
  }
}

function ReplyTrigger({ target }: { target: ReplyTarget }) {
  // The message the drawer was opened for is captured here: a page refresh that changes this thread's latest message never
  // changes the open drawer's message, and the drawer lives in this component, above the refreshed list data.
  const [openFor, setOpenFor] = useState<string | null>(null);
  // True when the drawer was reopened from the marker after a reload: it then never starts an AI draft by itself.
  const [restored, setRestored] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = useHomeScope();
  const laneId = scope?.laneId;
  const userId = scope?.userId;
  // The drawer itself writes the open marker once its context says the lane stores drafts (reply-drawer.tsx).
  const show = (id: string) => {
    setRestored(false);
    setOpenFor(id);
  };
  const hide = () => {
    setOpenFor(null);
    setRestored(false);
    if (laneId && userId) openDrawer.remove(laneId, userId, "current");
  };

  // Leaving Home (a client navigation) is not a reload: the open-drawer marker goes, so coming back does not pop the drawer up.
  // (A reload tears the page down without running this, which is exactly what lets the drawer reopen.)
  const openRef = useRef<string | null>(null);
  useEffect(() => {
    openRef.current = openFor;
  }, [openFor]);
  useEffect(
    () => () => {
      if (openRef.current && laneId && userId) openDrawer.remove(laneId, userId, "current");
    },
    [laneId, userId],
  );

  // A reload or back/forward with the drawer open: reopen it for the same message when that item is on the page (its fields come
  // back from sessionStorage). A fresh navigation (a link, the address bar) never reopens it: the marker is removed instead.
  // (In `next dev` a Fast Refresh remount of this component also runs the cleanup above and drops the marker: dev only.)
  useEffect(() => {
    if (!laneId || !userId) return;
    const marker = openDrawer.read(laneId, userId, "current");
    if (!marker) return;
    if (!reloaded()) {
      openDrawer.remove(laneId, userId, "current");
      return;
    }
    if (marker.messageId === target.messageId) {
      queueMicrotask(() => {
        setRestored(true);
        setOpenFor(target.messageId);
      });
    }
  }, [laneId, userId, target.messageId]);

  // Back from the step-up: /<lane>?reply=<message id> reopens this message's drawer (its fields come back from sessionStorage).
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("reply") === target.messageId) {
        queueMicrotask(() => show(target.messageId));
        url.searchParams.delete("reply");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      // no window or an odd URL: the owner just clicks Reply again
    }
  }, [target.messageId]);

  return (
    <>
      <Button ref={trigger} variant="outline" size="sm" data-testid="attention-reply" data-has-draft={target.proposalId ? "true" : "false"} aria-haspopup="dialog" onClick={() => show(target.messageId)}>
        Reply
      </Button>
      {openFor ? (
        <ReplyDrawer
          laneId={target.laneId}
          messageId={openFor}
          restored={restored}
          onClose={() => {
            hide();
            // Focus goes back to the button that opened the drawer.
            queueMicrotask(() => trigger.current?.focus());
          }}
        />
      ) : null}
    </>
  );
}
