"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut } from "@/app/auth/actions";
import { Icon, type IconName } from "@/components/Icon";

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Other route prefixes that belong to this section. */
  match?: string[];
  external?: boolean;
}

const PRIMARY: NavItem[] = [
  { href: "/", label: "Translate", icon: "translate", match: ["/episodes"] },
  { href: "/reimagine", label: "Reimagine", icon: "sparkles" },
  { href: "/novel", label: "Novel", icon: "bookOpen" },
  { href: "/source", label: "Source", icon: "library", match: ["/books"] },
];

const SECONDARY: NavItem[] = [
  { href: "/jobs", label: "Jobs", icon: "jobs" },
  { href: "/memory", label: "Memory", icon: "memory" },
  { href: "/docs", label: "Docs", icon: "docs", external: true },
];

function isActive(pathname: string, item: NavItem) {
  if (item.href === "/") {
    return pathname === "/" || (item.match ?? []).some((p) => pathname.startsWith(p));
  }
  return [item.href, ...(item.match ?? [])].some((p) => pathname.startsWith(p));
}

export function Sidebar({ email, workspace }: { email: string; workspace: string | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile drawer whenever navigation happens.
  useEffect(() => setOpen(false), [pathname]);

  const renderItem = (item: NavItem) => {
    const active = isActive(pathname, item);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={active ? "nav-item active" : "nav-item"}
        aria-current={active ? "page" : undefined}
        {...(item.external ? { target: "_blank", rel: "noreferrer", prefetch: false } : {})}
      >
        <Icon name={item.icon} size={17} />
        {item.label}
      </Link>
    );
  };

  return (
    <>
      <div className="mobile-bar">
        <button
          type="button"
          className="icon-btn"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? "close" : "menu"} size={20} />
        </button>
        <Link href="/" className="logo">
          <span className="logo-mark">V</span>
          Vaani
        </Link>
      </div>

      {open ? <div className="sidebar-scrim" onClick={() => setOpen(false)} /> : null}

      <aside className={open ? "sidebar open" : "sidebar"}>
        <Link href="/" className="logo sidebar-logo">
          <span className="logo-mark">V</span>
          Vaani
        </Link>

        <nav className="nav-group" aria-label="Main">
          {PRIMARY.map(renderItem)}
        </nav>

        <div className="spacer" />

        <nav className="nav-group" aria-label="Workspace">
          {SECONDARY.map(renderItem)}
          <form action={signOut}>
            <button type="submit" className="nav-item">
              <Icon name="logout" size={17} />
              Logout
            </button>
          </form>
        </nav>

        <div className="sidebar-user" title={email}>
          <div className="sidebar-user-email">{email}</div>
          {workspace ? <div className="sidebar-user-org">{workspace}</div> : null}
        </div>
      </aside>
    </>
  );
}
