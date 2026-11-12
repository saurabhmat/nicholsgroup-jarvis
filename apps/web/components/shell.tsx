"use client";
// Client wrapper for the app shell: supplies the current path and Next's Link to the presentational AppShell.
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { clearAllDrafts } from "@/lib/reply-draft-store";
import { ThemeToggle } from "./theme-toggle";
import { AppShell, type OnboardingProgress, type ShellBrand, type ShellLane, type ShellLink } from "@nichols/ui";

const NextLink: ShellLink = ({ href, ...rest }) => <Link href={href} {...rest} />;

export function Shell(props: {
  brand: ShellBrand;
  lanes: ShellLane[];
  currentLaneId: string;
  approvalsCount?: number;
  /** Setup progress; null for users without the brain view. */
  onboarding?: OnboardingProgress | null;
  signOut: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // Sign-out first removes this tab's unsent drafts (T-234 part 3).
  const signOut = async (formData: FormData) => {
    clearAllDrafts();
    await props.signOut(formData);
  };
  return <AppShell {...props} signOut={signOut} pathname={pathname} Link={NextLink} menuExtra={<ThemeToggle />} />;
}
