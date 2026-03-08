/**
 * F — Legacy canonical fact component (deprecated).
 *
 * The old facts pipeline has been retired in favor of the KB system (<KBF>).
 * This component is a passthrough shim that renders children inline.
 * Pages still referencing <F> should be migrated to <KBFactValue>.
 */

interface FProps {
  e?: string;
  f?: string;
  showDate?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export function F({ children, className }: FProps) {
  if (children) {
    return <span className={className}>{children}</span>;
  }
  // Self-closing <F /> with no children — nothing useful to render
  return null;
}
