import { type AnchorHTMLAttributes } from "react";
import { isSafeUrl } from "@lib/url-utils";

type SafeExternalLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  /** The URL to link to. Returns null if missing or unsafe (javascript:, data:, etc.). */
  href: string | null | undefined;
};

/**
 * A safe wrapper for external links backed by DB-sourced URLs.
 *
 * - Validates `href` with `isSafeUrl()` — rejects javascript:, data:, and other dangerous schemes.
 * - Returns null instead of rendering an <a> tag when the URL is missing or unsafe.
 * - Always sets `target="_blank"` and `rel="noopener noreferrer"`.
 *
 * Usage replaces the manual guard pattern:
 *   `{url && isSafeUrl(url) && <a href={url} target="_blank" rel="noopener noreferrer">…</a>}`
 *
 * With:
 *   `<SafeExternalLink href={url} className="…">…</SafeExternalLink>`
 */
export function SafeExternalLink({
  href,
  children,
  ...props
}: SafeExternalLinkProps) {
  if (!href || !isSafeUrl(href)) return null;

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}
