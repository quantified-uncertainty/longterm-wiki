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
    if (parsed.hostname.startsWith("www.")) {
      const noWww = base.replace("://www.", "://");
      variants.add(noWww);
      variants.add(noWww + "/");
    } else {
      const withWww = base.replace("://", "://www.");
      variants.add(withWww);
      variants.add(withWww + "/");
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "urlVariants parse failed");
    variants.add(url);
  }
  return Array.from(variants);
}
