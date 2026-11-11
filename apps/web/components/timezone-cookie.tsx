"use client";
// Tells the server the viewer's time zone (T-231a) so Home renders times in it. Sets the `tz` cookie (a zone name only,
// no personal data) and refreshes once when it changed. The server validates the value and falls back to New York.
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function TimezoneCookie({ current }: { current: string | null }) {
  const router = useRouter();
  useEffect(() => {
    let tz: string | undefined;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!tz || tz === current || !/^[A-Za-z][A-Za-z0-9_+./-]{0,63}$/.test(tz)) return;
    document.cookie = `tz=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax; secure`;
    router.refresh();
  }, [current, router]);
  return null;
}
