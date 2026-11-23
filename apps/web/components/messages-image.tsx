"use client";
// An inline picture of a Teams message (T-285; spec 8.5). The browser loads it ONLY from this portal's own image route (a same-site address built on the server from validated ids); it never
// sees a Microsoft address or a token, and nothing is loaded from any other host. Lazy, in a box of fixed size so the layout does not jump while it loads; a click opens the same route (and
// nothing else) in a new tab. If the route answers anything but an image (too large, not an image, Microsoft said no, busy, offline) the box turns into the neutral placeholder text.
import { useState } from "react";
import { MESSAGES_IMAGE_TEXT } from "@/lib/teams-wording";

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

export function HostedImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !OWN_ROUTE.test(src)) return <ImagePlaceholder />;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" data-testid="hosted-image-link" className="inline-block max-w-full align-top">
      {/* a fixed box (not the picture's own size) keeps the page from jumping; `object-contain` shows the whole picture */}
      <span className="block h-48 w-64 max-w-full overflow-hidden rounded-control border border-border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- a same-site, no-store route: the framework's image optimiser must not fetch or cache it */}
        <img src={src} alt="Image" loading="lazy" decoding="async" referrerPolicy="no-referrer" data-testid="hosted-image" className="h-full w-full object-contain" onError={() => setFailed(true)} />
      </span>
    </a>
  );
}
