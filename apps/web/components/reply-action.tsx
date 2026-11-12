"use client";
// The "Reply" action on a Needs-your-attention item (T-234 part 3). For the OWNER it opens the Reply drawer (reply-drawer.tsx):
// a side drawer on a desktop, a full-screen sheet on a phone. Other roles cannot send, so for them Reply is a plain link to the
// thread in Jarvis (the same as "Open"). Same props as before (`target`), plus `canReply`, so the attention list is unchanged.
// Coming back from the authenticator step (`?reply=<message id>`) the drawer for that message reopens by itself.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@nichols/ui";
import { inboxHref } from "@/lib/inbox-links";
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
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  // Back from the step-up: /<lane>?reply=<message id> reopens this message's drawer (its fields come back from sessionStorage).
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("reply") === target.messageId) {
        queueMicrotask(() => setOpen(true));
        url.searchParams.delete("reply");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      // no window or an odd URL: the owner just clicks Reply again
    }
  }, [target.messageId]);

  return (
    <>
      <Button ref={trigger} variant="outline" size="sm" data-testid="attention-reply" data-has-draft={target.proposalId ? "true" : "false"} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Reply
      </Button>
      {open ? (
        <ReplyDrawer
          laneId={target.laneId}
          messageId={target.messageId}
          onClose={() => {
            setOpen(false);
            // Focus goes back to the button that opened the drawer.
            queueMicrotask(() => trigger.current?.focus());
          }}
        />
      ) : null}
    </>
  );
}
