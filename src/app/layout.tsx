import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { getCurrentOrg, getUser } from "@/lib/supabase/server";
import { Sidebar } from "@/components/Sidebar";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

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
    <html lang="en" className={inter.variable}>
      <body>
        {user ? (
          <div className="app">
            <Sidebar email={user.email ?? ""} workspace={org?.name ?? null} />
            <main className="main">{children}</main>
          </div>
        ) : (
          <main className="auth-shell">{children}</main>
        )}
      </body>
    </html>
  );
}
