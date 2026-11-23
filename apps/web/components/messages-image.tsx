"use client";
// An inline picture of a Teams message (T-285; spec 8.5). The browser loads it ONLY from this portal's own image route (a same-site address built on the server from validated ids); it never
// sees a Microsoft address or a token, and nothing is loaded from any other host. Lazy, in a box of fixed size so the layout does not jump while it loads; a click opens the same route (and
// nothing else) in a new tab. If the route answers anything but an image (too large, not an image, Microsoft said no, busy, offline) the box turns into a "tap to load" button (one automatic retry after a 429, then by hand).
import { useEffect, useRef, useState } from "react";
import { MESSAGES_IMAGE_TAP_TEXT, MESSAGES_IMAGE_TEXT } from "@/lib/teams-wording";

const PLACEHOLDER = "inline-block rounded-control border border-dashed border-border px-2 py-0.5 text-small text-muted-foreground";
/** Only this portal's own image route is ever used as a picture source. */
const OWN_ROUTE = /^\/api\/lanes\/[A-Z]{1,8}\/messages\/image\?[A-Za-z0-9_%&=.:@~-]{1,1200}$/;

export function ImagePlaceholder() {
  return (
    <span data-testid="image-placeholder" className={PLACEHOLDER}>
      {MESSAGES_IMAGE_TEXT}
    </span>
  );
}

/** Longest the page waits on a 429's Retry-After before its one automatic retry. */
const IMAGE_RETRY_MAX_SECONDS = 10;

export function HostedImage({ src }: { src: string }) {
  const [phase, setPhase] = useState<"img" | "waiting" | "failed">("img");
  const [attempt, setAttempt] = useState(0); // remounts the <img>: the same route, the same address (the route sends no-store, so nothing is cached)
  const autoUsed = useRef(false); // ONE automatic retry per picture, ever: no loop
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!OWN_ROUTE.test(src)) return <ImagePlaceholder />;

  // The <img> cannot say why it failed. The one automatic retry first asks the same route once for the status: a 429 is waited out (Retry-After, at most IMAGE_RETRY_MAX_SECONDS) and the
  // picture is loaded again once; any other failure leaves the "tap to load" button. The button retries by hand, one attempt per tap.
  async function onError() {
    if (autoUsed.current) {
      setPhase("failed");
      return;
    }
    autoUsed.current = true;
    setPhase("waiting");
    let again = false;
    try {
      const r = await fetch(`/api/lanes/${src.slice("/api/lanes/".length)}`, { credentials: "same-origin", cache: "no-store" });
      await r.body?.cancel().catch(() => undefined);
      if (r.status === 429) {
        const asked = Number(r.headers.get("retry-after"));
        const seconds = Math.min(IMAGE_RETRY_MAX_SECONDS, Math.max(1, Number.isFinite(asked) && asked > 0 ? Math.ceil(asked) : 2));
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        again = true;
      } else again = r.ok; // the route answered an image this time: show it
    } catch {
      again = false;
    }
    if (!alive.current) return;
    if (again) {
      setAttempt((n) => n + 1);
      setPhase("img");
    } else setPhase("failed");
  }

  if (phase === "failed") {
    return (
      <button
        type="button"
        data-testid="image-retry"
        onClick={() => {
          setAttempt((n) => n + 1);
          setPhase("img");
        }}
        className={`${PLACEHOLDER} cursor-pointer hover:bg-muted`}
      >
        {MESSAGES_IMAGE_TAP_TEXT}
      </button>
    );
  }
  if (phase === "waiting") {
    return (
      <span data-testid="image-waiting" role="status" aria-busy="true" className={PLACEHOLDER}>
        {MESSAGES_IMAGE_TAP_TEXT}
      </span>
    );
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" aria-label="Image (opens in a new tab)" data-testid="hosted-image-link" className="inline-block max-w-full align-top">
      {/* a fixed box (not the picture's own size) keeps the page from jumping; the picture is never scaled UP and is shown whole */}
      <span className="flex h-48 w-64 max-w-full items-center justify-center overflow-hidden rounded-control border border-border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- a same-site, no-store route: the framework's image optimiser must not fetch or cache it */}
        <img key={attempt} src={src} alt="Image" loading="lazy" decoding="async" referrerPolicy="no-referrer" data-testid="hosted-image" className="max-h-full max-w-full object-contain" onError={() => void onError()} />
      </span>
    </a>
  );
}
