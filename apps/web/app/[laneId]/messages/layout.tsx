import { ModuleGate } from "@/components/module-gate";
import { MessagesLayoutShell, startMessages } from "@/components/messages-page";

// T-296: the Messages LAYOUT draws the header, the connect states and (for a connected person) the chat list, once. A layout is not rendered again when only `?conn=`, `?chat=` or `?tab=` change, so a
// chat click no longer reads every account's chat list (spec docs/specs/messages.md 22.6); the page (page.tsx) draws the conversation side. A layout runs beside its page, not before it, so the module gate
// is checked HERE too: a company that hides Messages is sent Home before any of the frame or the list is drawn. The layout is synchronous and reads no address: no Graph request runs on a link
// prefetch (the reads are in dynamic sections behind the gate and the connect state, inside Suspense), and no chat data is part of the prefetched shell.
export default function MessagesLayout({ children, params }: LayoutProps<"/[laneId]/messages">) {
  startMessages(params);
  return (
    <ModuleGate module="messages" params={params}>
      <MessagesLayoutShell params={params}>{children}</MessagesLayoutShell>
    </ModuleGate>
  );
}
