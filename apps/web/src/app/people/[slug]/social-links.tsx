import type { Fact } from "@longterm-wiki/kb";
import { safeHref } from "@/lib/directory-utils";

/**
 * Social link definition — maps a KB property to display config.
 */
interface SocialLinkDef {
  /** KB property ID */
  property: string;
  /** Display label */
  label: string;
  /** SVG icon path data (rendered inside a 24x24 viewBox) */
  iconPath: string;
  /** Given the fact text value, return the full URL */
  toUrl: (value: string) => string;
}

const SOCIAL_LINKS: SocialLinkDef[] = [
  {
    property: "website",
    label: "Website",
    // Globe icon
    iconPath:
      "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
    toUrl: (v) => v,
  },
  {
    property: "social-media",
    label: "X / Twitter",
    // X (Twitter) icon
    iconPath:
      "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
    toUrl: (v) => {
      const handle = v.replace(/^@/, "");
      return `https://x.com/${handle}`;
    },
  },
  {
    property: "github-profile",
    label: "GitHub",
    // GitHub icon
    iconPath:
      "M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z",
    toUrl: (v) => v,
  },
  {
    property: "google-scholar",
    label: "Google Scholar",
    // Graduation cap / scholar icon
    iconPath:
      "M12 3L1 9l4 2.18v6L12 21l7-3.82v-6l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z",
    toUrl: (v) => v,
  },
  {
    property: "wikipedia-url",
    label: "Wikipedia",
    // W icon (simplified Wikipedia)
    iconPath:
      "M12.09 13.119c-.14 1.064-.44 2.098-.876 3.076l-1.264 2.828-.252.504L6.476 12.2 4.75 17.092 3.5 21.5l-1-.34L5.7 12.03l.252-.672L3.356 4.5h1.36l2.1 5.88L8.424 4.5h1.26l-2.34 6.552c.816-.048 1.464.24 1.944.864.48.624.84 1.44 1.08 2.448l.252-.504 1.764-3.552L13.536 4.5h1.248L12.54 9.96l1.596 3.528L17.592 4.5h1.26l-4.2 9.372-2.16 4.632-.252.504c-.456-.96-.78-1.98-.936-3.06L12.09 13.12z",
    toUrl: (v) => v,
  },
];

interface SocialLinksProps {
  /** All facts for this entity, keyed by property ID */
  facts: Record<string, Fact | undefined>;
}

/**
 * Renders a row of small social link icons for a person profile page.
 * Reads from KB facts: website, social-media, github-profile, google-scholar, wikipedia-url.
 */
export function SocialLinks({ facts }: SocialLinksProps) {
  const links: Array<{ label: string; url: string; iconPath: string }> = [];

  for (const def of SOCIAL_LINKS) {
    const fact = facts[def.property];
    if (!fact || fact.value.type !== "text") continue;
    const url = def.toUrl(fact.value.value);
    if (!url) continue;
    links.push({ label: def.label, url, iconPath: def.iconPath });
  }

  if (links.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-3">Links</h2>
      <div className="flex flex-wrap gap-2">
        {links.map((link) => (
          <a
            key={link.label}
            href={safeHref(link.url)}
            target="_blank"
            rel="noopener noreferrer"
            title={link.label}
            className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-border/60 bg-card text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors"
          >
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="w-4.5 h-4.5"
              aria-hidden="true"
            >
              <path d={link.iconPath} />
            </svg>
            <span className="sr-only">{link.label}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
