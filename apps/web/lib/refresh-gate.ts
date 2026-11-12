// The pause switch of the Home auto-refresh (T-234 part 5). A module-level store: the reply drawer takes a "hold" while it is
// open and another while a send is in progress; the refresh timer asks `isHeld()` before every tick and subscribes so it can
// run one catch-up refresh once the last hold is released. Holds are counted by token, so two holders never release each other.
export type HoldKind = "drawer" | "sending";

const holds = new Map<symbol, HoldKind>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

/** Take a hold; the returned function releases exactly this hold (safe to call twice). */
export function holdRefresh(kind: HoldKind): () => void {
  const token = Symbol(kind);
  holds.set(token, kind);
  emit();
  return () => {
    if (holds.delete(token)) emit();
  };
}

export const isRefreshHeld = (): boolean => holds.size > 0;
export const heldKinds = (): HoldKind[] => [...holds.values()];

export function subscribeRefreshGate(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tests only. */
export function resetRefreshGate(): void {
  holds.clear();
  listeners.clear();
}
