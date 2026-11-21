// At most N requests in flight per mailbox (T-256, spec §8.5). Process-wide, keyed by lane + connection, so every client for
// one mailbox shares the limit and a throttled mailbox (its requests sleeping on Retry-After inside the shared client) only
// holds back its own queue: another connection, tenant or lane has its own key and never waits for it.
import { abortError, raceAbort } from "../http/rate-limit";

type Slot = { active: number; waiters: (() => void)[] };
const slots = new Map<string, Slot>();

function release(key: string, s: Slot): void {
  const next = s.waiters.shift();
  if (next) {
    next(); // the slot passes straight to the next waiter: `active` stays as it is
    return;
  }
  s.active -= 1;
  if (s.active <= 0 && slots.get(key) === s) slots.delete(key);
}

export async function withMailboxSlot<T>(key: string, max: number, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw abortError(signal);
  let s = slots.get(key);
  if (!s) slots.set(key, (s = { active: 0, waiters: [] }));
  const slot = s;
  if (slot.active < max) {
    slot.active += 1;
  } else {
    let wake: () => void = () => undefined;
    const turn = new Promise<void>((resolve) => (wake = resolve));
    slot.waiters.push(wake);
    try {
      await raceAbort(turn, signal);
    } catch (e) {
      const i = slot.waiters.indexOf(wake);
      if (i >= 0) slot.waiters.splice(i, 1);
      else release(key, slot); // the slot had already been handed to us: pass it on
      throw e;
    }
  }
  try {
    return await work();
  } finally {
    release(key, slot);
  }
}

/** Test helper. */
export function resetMailboxSlotsForTests(): void {
  slots.clear();
}
