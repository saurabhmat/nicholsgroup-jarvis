"use client";
// Client wrapper for the app shell: supplies the current path and Next's Link to the presentational AppShell.
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { clearAllDrafts } from "@/lib/reply-draft-store";
import { MessagesDot } from "./messages-dot";
import { ThemeToggle } from "./theme-toggle";
import { AppShell, type NavKey, type ShellBrand, type ShellLane, type ShellLink } from "@nichols/ui";

const NextLink: ShellLink = ({ href, ...rest }) => <Link href={href} {...rest} />;

export function Shell(props: {
  brand: ShellBrand;
  lanes: ShellLane[];
  currentLaneId: string;
  /** Navigation entries the company does not use (lib/lane-modules.ts). */
  hiddenKeys?: readonly NavKey[];
  /** The session user's first name for the phone header band's Home title. */
  firstName?: string;
  /** The server's time (the greeting), so the client render never reads the clock (T-243). */
  now?: Date;
  signOut: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // Sign-out first removes this tab's unsent drafts (T-234 part 3).
  const signOut = async (formData: FormData) => {
    clearAllDrafts();
    await props.signOut(formData);
  };
  // T-290: the "new" dot of Messages (side menu, and the iPhone More tab that holds Messages). Only when the company shows Messages; fetched by the dot itself after this renders.
  const messagesShown = !(props.hiddenKeys ?? []).includes("messages");
  const navAccessory = (key: NavKey | "more") => (messagesShown && (key === "messages" || key === "more") ? <MessagesDot laneId={props.currentLaneId} /> : null);
  return <AppShell {...props} signOut={signOut} pathname={pathname} Link={NextLink} menuExtra={<ThemeToggle />} navAccessory={navAccessory} />;
}
