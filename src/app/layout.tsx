import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getCurrentOrg, getUser } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/SignOutButton";

export const metadata: Metadata = {
  title: "Vaani - script localisation",
  description:
    "Translate comic, animation and dubbing scripts across English and 22 Indian languages, with translation memory and human review.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getUser();
  const org = user ? await getCurrentOrg() : null;

  return (
    <html lang="en">
      <body>
        {user ? (
          <header className="topbar">
            <div className="topbar-inner">
              <Link href="/" className="brand">
                Vaani
                {org ? <span>{org.name}</span> : null}
              </Link>
              <div className="spacer" />
              <Link href="/memory" className="small muted">
                Translation memory
              </Link>
              <span className="small faint">{user.email}</span>
              <SignOutButton />
            </div>
          </header>
        ) : null}
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
