import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui class helper: conditional classes, later Tailwind classes win. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// Deliberately strict: no "%" (mail clients percent-decode mailto addresses), no query,
// header, whitespace, quotes or angle brackets, so a caller-supplied value cannot add
// recipients or headers to a mailto link.
const SAFE_EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export function isSafeEmail(value: string): boolean {
  return value.length <= 254 && SAFE_EMAIL.test(value);
}

const MAX_SUBJECT_LENGTH = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * `mailto:` href for a validated address, or undefined when the address is not safe.
 * The subject has control characters (CR/LF etc.) removed, is capped at 200 characters
 * and is percent-encoded.
 */
export function mailtoHref(email: string, subject?: string): string | undefined {
  if (!isSafeEmail(email)) return undefined;
  const cleanSubject = subject?.replace(CONTROL_CHARS, "").slice(0, MAX_SUBJECT_LENGTH);
  return cleanSubject ? `mailto:${email}?subject=${encodeURIComponent(cleanSubject)}` : `mailto:${email}`;
}
