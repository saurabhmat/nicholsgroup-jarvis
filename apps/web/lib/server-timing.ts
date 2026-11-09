// T-230 A: request-scoped timings (names and durations only: never an id, an email, a token or any data).
// Where the numbers go:
// - the proxy sets a `Server-Timing` response header (a proxy can set headers; a server component streaming its response
//   cannot, and Next 16 App Router has no trailers), and
// - server components (guards, lane check, page loaders) write one log line per span: `[timing] {"req","name","start","ms"}`;
//   `req` is a random per-request id that only groups the lines of one request.
// Off by default in production; on in `next dev` or with the server env var SERVER_TIMING=1 (set by the operator, never by a
// request: no header or query can switch it on, so a user cannot learn more than the operator chose to publish).
import { randomUUID } from "node:crypto";

export type TimingEntry = { name: string; start: number; ms: number };

/** True in `next dev`, or when the server's SERVER_TIMING env var is exactly "1". Read per call so tests can flip it. */
export function timingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development" || env.SERVER_TIMING === "1";
}

/** Metric names are fixed literals chosen in code; anything outside [a-z0-9._-] is replaced so a header can never be split. */
export function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 48) || "span";
}

export type Timings = {
  readonly id: string;
  /** Runs `fn`, recording its duration under `name` when timing is on; otherwise just runs it. Errors pass through unchanged. */
  time<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  entries(): TimingEntry[];
  /** `name;dur=1.2, name2;dur=3.4` for the Server-Timing header. */
  header(): string;
};

export function createTimings(log: ((line: string) => void) | null = (line) => console.info(line), enabled: () => boolean = timingEnabled): Timings {
  const t0 = performance.now();
  const id = randomUUID().slice(0, 8);
  const list: TimingEntry[] = [];
  return {
    id,
    async time(name, fn) {
      if (!enabled()) return fn();
      const start = performance.now();
      try {
        return await fn();
      } finally {
        const entry = { name: safeName(name), start: round(start - t0), ms: round(performance.now() - start) };
        list.push(entry);
        log?.(`[timing] ${JSON.stringify({ req: id, ...entry, at: Date.now() })}`);
      }
    },
    entries: () => [...list],
    header: () => list.map((e) => `${e.name};dur=${String(e.ms)}`).join(", "),
  };
}

const round = (n: number) => Math.round(n * 10) / 10;
