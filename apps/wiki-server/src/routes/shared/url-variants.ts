import { logger } from "../../logger.js";

/**
 * Generate common URL variants for fuzzy lookup.
 * Tries with/without www, with/without trailing slash.
 *
 * Used by the resource suggest endpoint to match input URLs against existing
 * resources stored with slightly different URL forms.
 */
export function urlVariants(url: string): string[] {
  const variants = new Set<string>();
  try {
    const parsed = new URL(url);
    const base = parsed.href.replace(/\/$/, "");
    variants.add(base);
    variants.add(base + "/");

    // Use URL API to manipulate hostname correctly (handles auth, ports, etc.)
    // Skip www expansion for IPs and localhost — www.192.168.1.1 / www.localhost are invalid
    const isIpOrLocalhost =
      /^(\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname) ||
      /^\[.*\]$/.test(parsed.hostname) || // IPv6
      parsed.hostname === "localhost";

    if (parsed.hostname.startsWith("www.")) {
      const noWww = new URL(parsed.href);
      noWww.hostname = noWww.hostname.slice(4);
      const noWwwBase = noWww.href.replace(/\/$/, "");
      variants.add(noWwwBase);
      variants.add(noWwwBase + "/");
    } else if (!isIpOrLocalhost) {
      const withWww = new URL(parsed.href);
      withWww.hostname = "www." + withWww.hostname;
      const withWwwBase = withWww.href.replace(/\/$/, "");
      variants.add(withWwwBase);
      variants.add(withWwwBase + "/");
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "urlVariants parse failed");
    variants.add(url);
  }
  return Array.from(variants);
}
