"use client";
// "Sync now" (T-238 part B): asks the portal to sync every connected Google account right away (POST /api/lanes/<lane>/sync-now;
// owner or admin_technical, one per 2 minutes, checked on the server). Only drawn for those roles (the caller decides). The result
// is a fixed text by the server's CODE or status, never the server's own message, shown in a polite live region. After a start the
// page is refreshed twice so the sync status line catches up (the sync takes a few seconds).
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@nichols/ui";

export const SYNC_NOW_TEXT = {
  started: "Sync started. The times below update in a few seconds.",
  none: "No Google account is connected to sync.",
  forbidden: "Only an owner or technical administrator can start a sync.",
  signedOut: "You are signed out. Sign in again and retry.",
  failed: "Could not start the sync. Try again in a minute.",
  network: "Could not reach the portal. Check your connection and try again.",
} as const;
export const rateLimitedText = (seconds: number): string => `A sync was just started. You can start another in ${String(Math.max(1, Math.min(120, Math.ceil(seconds))))} seconds.`;

/** The fixed text for a response (status plus the JSON body's `status` / `error` / `retryAfterSeconds`). */
export function syncNowText(status: number, body: { status?: unknown; error?: unknown; retryAfterSeconds?: unknown }): { text: string; ok: boolean } {
  if (status === 200 && body.status === "started") return { text: SYNC_NOW_TEXT.started, ok: true };
  if (status === 200 && body.status === "no_connections") return { text: SYNC_NOW_TEXT.none, ok: false };
  if (status === 429) return { text: rateLimitedText(typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : 120), ok: false };
  if (status === 401) return { text: SYNC_NOW_TEXT.signedOut, ok: false };
  if (status === 403 || status === 404) return { text: SYNC_NOW_TEXT.forbidden, ok: false };
  return { text: SYNC_NOW_TEXT.failed, ok: false };
}

const REFRESH_AFTER_MS = [6_000, 20_000];

export function SyncNowButton({ laneId, className, testId = "sync-now" }: { laneId: string; className?: string; testId?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  async function click() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/sync-now`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { status?: unknown; error?: unknown; retryAfterSeconds?: unknown };
      const out = syncNowText(res.status, body);
      setMessage(out.text);
      if (out.ok) {
        timers.current.forEach(clearTimeout);
        timers.current = REFRESH_AFTER_MS.map((ms) => setTimeout(() => router.refresh(), ms));
      }
    } catch {
      setMessage(SYNC_NOW_TEXT.network);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${className ?? ""}`}>
      <Button variant="outline" size="sm" data-testid={testId} disabled={busy} aria-busy={busy} onClick={() => void click()}>
        {busy ? "Starting…" : "Sync now"}
      </Button>
      {/* Always mounted so assistive technology announces the change; empty until there is a result. */}
      <span role="status" aria-live="polite" data-testid={`${testId}-result`} className={message ? "text-small text-muted-foreground" : "sr-only"}>
        {message}
      </span>
    </span>
  );
}
