import { extractDomain } from "@/lib/resource-types";
import { getPublicationByDomain } from "@/data/tablebase";

/**
 * Domain-to-name lookup for sources commonly referenced in legislation stakeholder data.
 *
 * The publications database (`data/publications.yaml`) covers major news outlets, academic
 * journals, and AI lab blogs. This table covers the long tail of advocacy organizations,
 * government sites, industry groups, and niche publications that appear in stakeholder
 * source URLs but aren't in the publication database.
 *
 * Keys are bare domains (no "www." prefix). Subdomain matching is supported: a URL like
 * "about.fb.com" will match the "fb.com" entry.
 */
const DOMAIN_DISPLAY_NAMES: Record<string, string> = {
  // ── Tech companies & labs ──
  "a16z.com": "Andreessen Horowitz",
  "fb.com": "Meta",
  "aboutamazon.eu": "Amazon EU",
  "blogs.microsoft.com": "Microsoft",
  "cta.tech": "Consumer Technology Association",

  // ── Government ──
  "gov.ca.gov": "Office of the Governor of California",
  "governor.ny.gov": "Office of the Governor of New York",
  "nysenate.gov": "New York State Senate",
  "senate.ca.gov": "California State Senate",
  "house.gov": "U.S. House of Representatives",
  "leg.colorado.gov": "Colorado General Assembly",
  "ised-isde.canada.ca": "Innovation, Science and Economic Development Canada",
  "europarl.europa.eu": "European Parliament",

  // ── Civil society & advocacy ──
  "accessnow.org": "Access Now",
  "edri.org": "European Digital Rights (EDRi)",
  "digitaleurope.org": "DigitalEurope",
  "eff.org": "Electronic Frontier Foundation",
  "cdt.org": "Center for Democracy & Technology",
  "safesecureai.org": "Safe Secure AI",
  "thealliance.ai": "The AI Alliance",
  "transparencycoalition.ai": "Transparency Coalition",
  "rainn.org": "RAINN",
  "economicsecurity.us": "Foundation for American Innovation",
  "iclmg.ca": "ICLMG",

  // ── Industry groups ──
  "ccianet.org": "CCIA",
  "netchoice.org": "NetChoice",
  "technyc.org": "Tech:NYC",
  "progresschamber.org": "Chamber of Progress",
  "calchamber.com": "CalChamber",

  // ── Think tanks & research ──
  "cfr.org": "Council on Foreign Relations",
  "cigionline.org": "CIGI",
  "rstreet.org": "R Street Institute",
  "montrealethics.ai": "Montreal AI Ethics Institute",
  "fpf.org": "Future of Privacy Forum",
  "iapp.org": "IAPP",
  "securiti.ai": "Securiti",
  "texaspolicy.com": "Texas Public Policy Foundation",
  "commonsenseinstituteco.org": "Common Sense Institute",
  "digichina.stanford.edu": "Stanford DigiChina",

  // ── News & media ──
  "euronews.com": "Euronews",
  "fastcompany.com": "Fast Company",
  "sfstandard.com": "San Francisco Standard",
  "calmatters.org": "CalMatters",
  "coloradosun.com": "Colorado Sun",
  "politico.com": "Politico",
  "fedscoop.com": "FedScoop",
  "venturebeat.com": "VentureBeat",
  "biometricupdate.com": "Biometric Update",
  "techpolicy.press": "Tech Policy Press",
  "transformernews.ai": "Transformer",
};

/**
 * Derive a human-readable source name from a URL.
 *
 * Resolution order:
 * 1. Publication database (`data/publications.yaml`) — exact or subdomain match
 * 2. Domain display name lookup table (above) — exact or subdomain match
 * 3. Fallback: cleaned domain name with improved formatting
 */
export function getSourceDisplayName(url: string): string | undefined {
  const domain = extractDomain(url);
  if (!domain) return undefined;

  // 1. Try the publication database (handles subdomain matching internally)
  const pub = getPublicationByDomain(domain);
  if (pub) return pub.name;

  // 2. Try the domain display name lookup table
  const lookupName = lookupDomainDisplayName(domain);
  if (lookupName) return lookupName;

  // 3. Fallback: improved domain-to-name transformation
  return formatDomainFallback(domain);
}

/**
 * Look up a domain in the display name table.
 * Supports subdomain matching: "about.fb.com" matches "fb.com".
 */
function lookupDomainDisplayName(domain: string): string | undefined {
  // Exact match
  const exact = DOMAIN_DISPLAY_NAMES[domain];
  if (exact) return exact;

  // Subdomain match: check if domain ends with ".{tableDomain}"
  for (const [tableDomain, name] of Object.entries(DOMAIN_DISPLAY_NAMES)) {
    if (domain.endsWith(`.${tableDomain}`)) {
      return name;
    }
  }
  return undefined;
}

/**
 * Fallback domain-to-name transformation with improved heuristics.
 *
 * Improvements over the naive approach:
 * - Strips common subdomain prefixes ("about", "blog", "news", "advocacy")
 * - Strips all TLD suffixes including country codes and ".ai", ".press"
 * - Separates camelCase and concatenated words where possible
 */
export function formatDomainFallback(domain: string): string {
  // Strip common non-informative subdomains
  let cleaned = domain
    .replace(
      /^(about|blog|blogs|news|advocacy|support|campaign|www)\./i,
      "",
    );

  // Strip TLDs (including compound TLDs like .co.uk, .com.au)
  cleaned = cleaned
    .replace(
      /\.(com|org|net|io|co|gov|edu|us|uk|ca|au|eu|ai|press|tech)(\.(?:uk|au|us|ca))?$/i,
      "",
    );

  // Replace dots and hyphens with spaces
  cleaned = cleaned.replace(/[.\-_]/g, " ");

  // Insert space before camelCase transitions (e.g., "techPolicy" -> "tech Policy")
  cleaned = cleaned.replace(/([a-z])([A-Z])/g, "$1 $2");

  // Capitalize each word
  return cleaned
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
