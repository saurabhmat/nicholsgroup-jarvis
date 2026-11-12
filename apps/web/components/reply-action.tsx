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

function ReplyTrigger({ target }: { target: ReplyTarget }) {
  // The message the drawer was opened for is captured here: a page refresh that changes this thread's latest message never
  // changes the open drawer's message, and the drawer lives in this component, above the refreshed list data.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = useHomeScope();
  const laneId = scope?.laneId;
  const userId = scope?.userId;
  const show = (id: string) => {
    setOpenFor(id);
    if (laneId && userId) openDrawer.write(laneId, userId, "current", { messageId: id });
  };
  const hide = () => {
    setOpenFor(null);
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

  // A full reload with the drawer open: reopen it for the same message when that item is on the page (its fields come back from sessionStorage).
  useEffect(() => {
    if (!laneId || !userId) return;
    if (openDrawer.read(laneId, userId, "current")?.messageId === target.messageId) queueMicrotask(() => setOpenFor(target.messageId));
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
    // `show` only closes over the scope ids; it runs once per message id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
