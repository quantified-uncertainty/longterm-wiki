import type { Metadata } from "next";
import Link from "next/link";
import { DevModeToggle } from "@/components/DevModeToggle";
import { SearchButton, SearchDialog } from "@/components/SearchDialog";
import { MobileNav } from "@/components/MobileNav";
import { SITE_URL } from "@/lib/site-config";
import "./globals.css";
import "katex/dist/katex.min.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Longterm Wiki",
    template: "%s | Longterm Wiki",
  },
  description: "AI Safety Knowledge Base",
  openGraph: {
    title: "Longterm Wiki",
    description: "AI Safety Knowledge Base",
    type: "website",
    siteName: "Longterm Wiki",
    url: SITE_URL,
  },
  twitter: {
    card: "summary",
    title: "Longterm Wiki",
    description: "AI Safety Knowledge Base",
  },
  alternates: {
    types: {
      "application/atom+xml": `${SITE_URL}/feed.xml`,
    },
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Restore dev mode class before paint to prevent flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){if(localStorage.getItem('pageStatusDevMode')==='true'){document.documentElement.classList.add('page-status-dev-mode')}})()`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        {/* Top nav bar */}
        <header className="sticky top-0 z-40 border-b border-border bg-card">
          <div className="flex items-center">
            <Link href="/" className="w-64 shrink-0 px-4 py-3 text-lg font-bold no-underline text-foreground max-md:w-auto">
              Longterm Wiki
            </Link>
            <nav className="flex-1 flex items-center justify-end gap-4 px-6 py-3">
              <Link
                href="/wiki"
                className="hidden md:inline text-sm text-muted-foreground no-underline hover:text-foreground transition-colors"
              >
                Explore
              </Link>
              <Link
                href="/organizations"
                className="hidden md:inline text-sm text-muted-foreground no-underline hover:text-foreground transition-colors"
              >
                Organizations
              </Link>
              <Link
                href="/people"
                className="hidden md:inline text-sm text-muted-foreground no-underline hover:text-foreground transition-colors"
              >
                People
              </Link>
              <Link
                href="/risks"
                className="hidden md:inline text-sm text-muted-foreground no-underline hover:text-foreground transition-colors"
              >
                Risks
              </Link>
              <Link
                href="/grants"
                className="hidden md:inline text-sm text-muted-foreground no-underline hover:text-foreground transition-colors"
              >
                Grants
              </Link>
              <Link
                href="/sources"
                className="hidden md:inline text-sm text-muted-foreground no-underline hover:text-foreground transition-colors"
              >
                Sources
              </Link>
              <Link
                href="/kb"
                className="hidden md:inline text-sm text-muted-foreground no-underline hover:text-foreground transition-colors"
              >
                Data
              </Link>
              <Link
                href="/wiki/E755"
                className="hidden md:inline text-sm text-muted-foreground no-underline hover:text-foreground transition-colors"
              >
                About
              </Link>
              <Link
                href="/wiki/E779"
                className="hidden md:inline text-sm text-muted-foreground no-underline hover:text-foreground transition-colors"
              >
                Internal
              </Link>
              <Link
                href="/feed.xml"
                className="hidden md:inline text-muted-foreground no-underline hover:text-foreground transition-colors"
                title="Atom feed"
                target="_blank"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="size-4">
                  <circle cx="6.18" cy="17.82" r="2.18"/>
                  <path d="M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83c0-8.59-6.97-15.56-15.56-15.56zm0 5.66v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9z"/>
                </svg>
              </Link>
              <SearchButton />
              <DevModeToggle />
              <MobileNav />
            </nav>
          </div>
        </header>

        {/* Global search dialog (Cmd+K) */}
        <SearchDialog />

        {/* Main content */}
        <main>
          {children}
        </main>
      </body>
    </html>
  );
}
