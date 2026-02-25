/**
 * ClaimModeBadge — shows whether a claim is endorsed (wiki asserts it)
 * or attributed (wiki is reporting what someone else claims).
 */

interface Props {
  mode: string | null;
  attributedTo?: string | null;
  compact?: boolean;
}

export function ClaimModeBadge({ mode, attributedTo, compact = false }: Props) {
  if (!mode || mode === "endorsed") {
    if (compact) return null;
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-blue-50 text-blue-700 border border-blue-200">
        endorsed
      </span>
    );
  }

  // attributed
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-amber-50 text-amber-700 border border-amber-200"
      title={attributedTo ? `Attributed to: ${attributedTo}` : "Attributed claim"}
    >
      {compact ? (
        <>attributed{attributedTo ? `: ${attributedTo}` : ""}</>
      ) : (
        <>
          attributed
          {attributedTo && (
            <span className="text-amber-600 font-normal"> by {attributedTo}</span>
          )}
        </>
      )}
    </span>
  );
}
