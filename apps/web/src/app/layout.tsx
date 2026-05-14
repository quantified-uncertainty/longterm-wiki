import type { Metadata } from "next";
import Link from "next/link";
import Script from "next/script";
import { DevModeToggle } from "@/components/DevModeToggle";
import { SearchButton, SearchDialog } from "@/components/SearchDialog";
import { MobileNav } from "@/components/MobileNav";
import { DesktopNav } from "@/components/DesktopNav";
import { GlobalErrorReporter } from "@/components/GlobalErrorReporter";
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
  const plausibleDomain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN;
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
      <body className="min-h-screen bg-background text-foreground overflow-x-clip">
        {plausibleDomain ? (
          <Script
            data-domain={plausibleDomain}
            src="https://plausible.io/js/script.js"
          />
        ) : null}
        <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-card focus:border focus:border-border focus:rounded-md focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg">
          Skip to content
        </a>
        {/* Top nav bar */}
        <header className="sticky top-0 z-40 border-b border-border bg-card">
          <div className="flex items-center max-w-full">
            {/* Wordmark: w-64 only at lg+ (1024px) where the desktop nav can fit
                alongside it. Below lg, shrink to `w-auto` so the wordmark + hamburger
                don't collide (QUA-670). */}
            <Link href="/" className="lg:w-64 shrink-0 px-4 py-3 text-lg font-bold no-underline text-foreground">
              Longterm Wiki
            </Link>
            <nav aria-label="Main navigation" className="flex-1 flex items-center justify-end gap-4 px-6 py-3 min-w-0">
              <div className="hidden lg:flex items-center gap-4">
                <DesktopNav />
              </div>
              <Link
                href="/feed.xml"
                className="hidden lg:inline text-muted-foreground no-underline hover:text-foreground transition-colors"
                title="Atom feed"
                target="_blank"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="size-4" aria-hidden="true">
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

        <GlobalErrorReporter />

        {/* Main content */}
        <main id="main-content">
          {children}
        </main>
      </body>
    </html>
  );
}
