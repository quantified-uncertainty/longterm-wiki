import { isUrl, shortDomain } from "@/components/wiki/factbase/format";

/**
 * External source link that shows a short domain name.
 * Renders nothing if the source is not a URL.
 */
export function SourceLink({
  source,
  className,
}: {
  source: string | null | undefined;
  className?: string;
}) {
  if (!source || !isUrl(source)) return null;
  return (
    <a
      href={source}
      target="_blank"
      rel="noopener noreferrer"
      className={
        className ??
        "text-[10px] text-primary/50 hover:text-primary hover:underline mt-1 inline-block transition-colors"
      }
    >
      {shortDomain(source)}
    </a>
  );
}
