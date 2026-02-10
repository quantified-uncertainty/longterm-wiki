/**
 * FullWidthLayout — layout signal component
 *
 * In the old Astro app this component toggled the page to full-viewport width.
 * In Next.js, full-width is handled via `fullWidth: true` in page frontmatter
 * (which the layout reads). This component is kept as a no-op for backward
 * compatibility with MDX pages that still reference it.
 */
export function FullWidthLayout() {
  return null;
}
