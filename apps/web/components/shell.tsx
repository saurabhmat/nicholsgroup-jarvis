"use client";
// Client wrapper for the app shell: supplies the current path and Next's Link to the presentational AppShell.
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
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
  return <AppShell {...props} pathname={pathname} Link={NextLink} menuExtra={<ThemeToggle />} />;
}
