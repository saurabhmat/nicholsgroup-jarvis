// Claude and ChatGPT (T-271, Saurabh Nov 23, 2026): the vendor's own chat, nothing built around it. The lane check runs as on every
// page; then one card with a button that opens the vendor's site in a new tab (`noopener noreferrer`: the site gets no handle on this
// window and no referrer). No portal data is passed. If an embed method is found later, it replaces the card on this page.
import type { ReactNode } from "react";
import { buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle, cn, navItem, PageHeader } from "@nichols/ui";
import { EXTERNAL_CHATS, type ExternalChatKey } from "@/lib/external-chat";
import { LaneEyebrow } from "@/components/module-page";

// T-276: the heading and the card are fixed text and are drawn outside Suspense (part of the prefetched shell). The company name in the eyebrow, and with it
// the page's lane check (notFound / redirect, on every navigation), comes from a small async child (module-page.tsx `LaneName`).
export function ExternalChatPage({ chat, params }: { chat: ExternalChatKey; params: Promise<{ laneId: string }> }) {
  return <ExternalChatView chat={chat} laneName={<LaneEyebrow params={params} />} />;
}

export function ExternalChatView({ chat, laneName }: { chat: ExternalChatKey; laneName: ReactNode }) {
  const c = EXTERNAL_CHATS[chat];
  const item = navItem(chat);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={laneName} title={item.heading.lead} />
      <Card data-testid="external-chat">
        <CardHeader>
          <CardTitle as="h2">Open {c.name}</CardTitle>
          <CardDescription>
            {c.name} opens in a new tab, where you sign in with your own {c.name} account. Nothing from this portal is sent to {c.vendor}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <a href={c.url} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants(), "min-h-11 w-full sm:w-auto")}>
            Open {c.name}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
