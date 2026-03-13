import type { Fact } from "@longterm-wiki/kb";

/**
 * A social link parsed from available data sources.
 */
interface SocialLink {
  platform: string;
  label: string;
  url: string;
}

/**
 * Detect the platform from a URL and return a label.
 */
function detectPlatform(url: string): { platform: string; label: string } | null {
  const lower = url.toLowerCase();
  if (lower.includes("x.com/") || lower.includes("twitter.com/")) {
    const handle = url.split("/").pop();
    return { platform: "twitter", label: handle ? `@${handle.replace(/^@/, "")}` : "X / Twitter" };
  }
  if (lower.includes("github.com/")) {
    const parts = url.replace(/\/$/, "").split("/");
    const username = parts[parts.length - 1];
    return { platform: "github", label: username || "GitHub" };
  }
  if (lower.includes("linkedin.com/")) {
    return { platform: "linkedin", label: "LinkedIn" };
  }
  if (lower.includes("scholar.google.com/")) {
    return { platform: "scholar", label: "Google Scholar" };
  }
  if (lower.includes("wikipedia.org/")) {
    return { platform: "wikipedia", label: "Wikipedia" };
  }
  return null;
}

/**
 * SVG icons for each supported platform.
 * Kept minimal and inline to avoid external dependencies.
 */
function PlatformIcon({ platform }: { platform: string }) {
  const className = "w-3.5 h-3.5 shrink-0";

  switch (platform) {
    case "twitter":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      );
    case "github":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0012 2z" />
        </svg>
      );
    case "linkedin":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
        </svg>
      );
    case "scholar":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M5.242 13.769L0 9.5 12 0l12 9.5-5.242 4.269C17.548 11.249 14.978 9.5 12 9.5c-2.977 0-5.548 1.748-6.758 4.269zM12 10a7 7 0 100 14 7 7 0 000-14z" />
        </svg>
      );
    case "wikipedia":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12.09 13.119c-.936 1.932-2.217 4.548-2.853 5.728-.616 1.074-1.127.991-1.532.016C6.532 16.416 4.109 10.98 2.674 7.767c-.204-.46-.392-.768-.61-.966-.186-.17-.484-.286-1.064-.286V6h4.605v.515c-.65.02-1.094.156-1.094.646 0 .236.093.537.264.947l3.082 7.337 1.07-2.282L7.558 9.59c-.37-.75-.616-1.278-.616-1.654 0-.44.323-.653.983-.673V6.77H12.1v.515c-.565.04-.94.194-.94.654 0 .203.093.47.264.846l1.744 3.868 1.71-3.682c.154-.34.24-.636.24-.876 0-.424-.353-.627-.91-.66V6.77h3.473v.515c-.39.024-.724.09-.983.276-.258.186-.55.557-.834 1.088l-2.492 5.098 2.075 4.588c.537 1.073 1.134 1.122 1.605.043.44-1.017 2.037-4.59 3.314-7.55.268-.613.463-1.077.463-1.36 0-.424-.38-.623-.986-.65V6.77h3.93v.515c-.707.03-1.148.33-1.518 1.11l-4.228 9.08c-.556 1.18-1.073 1.168-1.607.06l-2.17-4.684-.56 1.123z" />
        </svg>
      );
    case "website":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    default:
      return null;
  }
}

/**
 * Collect social links from all available data sources for a person.
 */
export function collectSocialLinks({
  entityWebsite,
  expertWebsite,
  socialMediaFact,
  entitySources,
}: {
  entityWebsite?: string;
  expertWebsite?: string;
  socialMediaFact?: Fact;
  entitySources?: { title: string; url?: string }[];
}): SocialLink[] {
  const links: SocialLink[] = [];
  const seenUrls = new Set<string>();

  const addLink = (link: SocialLink) => {
    const normalized = link.url.replace(/\/$/, "").toLowerCase();
    if (seenUrls.has(normalized)) return;
    seenUrls.add(normalized);
    links.push(link);
  };

  // 1. Twitter/X from social-media KB fact
  if (socialMediaFact?.value.type === "text" && socialMediaFact.source) {
    const handle = socialMediaFact.value.value;
    addLink({
      platform: "twitter",
      label: handle.startsWith("@") ? handle : `@${handle}`,
      url: socialMediaFact.source,
    });
  }

  // 2. Entity sources — scan for known social platform URLs
  if (entitySources) {
    for (const src of entitySources) {
      if (!src.url) continue;
      const detected = detectPlatform(src.url);
      if (detected) {
        addLink({ platform: detected.platform, label: detected.label, url: src.url });
      }
    }
  }

  // 3. Personal website — use expert.website preferring over entity.website,
  //    but skip if it's an org website (heuristic: contains org-like domains)
  const website = expertWebsite || entityWebsite;
  if (website) {
    const detected = detectPlatform(website);
    if (detected) {
      // If the website IS a social platform link, add it as that platform
      addLink({ platform: detected.platform, label: detected.label, url: website });
    } else {
      // It's a personal website — add it with a "Website" label
      // Skip if it looks like a generic org website
      const lower = website.toLowerCase();
      const isOrgSite =
        lower.includes("anthropic.com") ||
        lower.includes("openai.com") ||
        lower.includes("deepmind.google") ||
        lower.includes("conjecture.dev") ||
        lower.includes("intelligence.org") ||
        lower.includes("alignment.org") ||
        lower.includes("redwoodresearch.org") ||
        lower.includes("safe.ai") ||
        lower.includes("ssi.inc") ||
        lower.includes("x.ai") ||
        lower.includes("metr.org");
      if (!isOrgSite) {
        try {
          const hostname = new URL(website).hostname.replace(/^www\./, "");
          addLink({ platform: "website", label: hostname, url: website });
        } catch {
          addLink({ platform: "website", label: "Website", url: website });
        }
      }
    }
  }

  return links;
}

/**
 * Horizontal row of social link badges for a person profile.
 * Renders only if there are links to show.
 */
export function SocialLinks({
  entityWebsite,
  expertWebsite,
  socialMediaFact,
  entitySources,
}: {
  entityWebsite?: string;
  expertWebsite?: string;
  socialMediaFact?: Fact;
  entitySources?: { title: string; url?: string }[];
}) {
  const links = collectSocialLinks({
    entityWebsite,
    expertWebsite,
    socialMediaFact,
    entitySources,
  });

  if (links.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-muted-foreground bg-muted/50 hover:bg-muted hover:text-foreground transition-colors"
        >
          <PlatformIcon platform={link.platform} />
          {link.label}
        </a>
      ))}
    </div>
  );
}
