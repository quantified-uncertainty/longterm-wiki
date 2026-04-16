import Link from "next/link";

interface Props {
  sinceDays: number;
  fetchStatus: string | null;
  sinceDaysOptions: number[];
  fetchStatusOptions: string[];
}

const BASE_PATH = "/internal/resource-pipeline-dashboard";

function buildHref(params: { sinceDays?: number; fetchStatus?: string | null }) {
  const qs = new URLSearchParams();
  if (params.sinceDays !== undefined) qs.set("sinceDays", String(params.sinceDays));
  if (params.fetchStatus) qs.set("fetchStatus", params.fetchStatus);
  const qsStr = qs.toString();
  return qsStr ? `${BASE_PATH}?${qsStr}` : BASE_PATH;
}

function FilterPill({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  const className = active
    ? "bg-foreground text-background"
    : "bg-muted text-muted-foreground hover:bg-muted/80";
  return (
    <Link
      href={href}
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-mono transition-colors ${className}`}
      prefetch={false}
    >
      {label}
    </Link>
  );
}

export function ResourcePipelineFilters({
  sinceDays,
  fetchStatus,
  sinceDaysOptions,
  fetchStatusOptions,
}: Props) {
  return (
    <div className="rounded-lg border border-border/60 p-4 space-y-3 not-prose">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide w-24">
          Window
        </span>
        {sinceDaysOptions.map((days) => (
          <FilterPill
            key={days}
            href={buildHref({ sinceDays: days, fetchStatus })}
            label={`${days}d`}
            active={days === sinceDays}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide w-24">
          Fetch status
        </span>
        <FilterPill
          href={buildHref({ sinceDays, fetchStatus: null })}
          label="all"
          active={fetchStatus === null}
        />
        {fetchStatusOptions.map((status) => (
          <FilterPill
            key={status}
            href={buildHref({ sinceDays, fetchStatus: status })}
            label={status}
            active={status === fetchStatus}
          />
        ))}
      </div>
    </div>
  );
}
