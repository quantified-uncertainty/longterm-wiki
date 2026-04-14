import Link from "next/link";
import { ArrowLeft, CircleHelp } from "lucide-react";
import { formatRecordType } from "@/app/sourcing/sourcing-shared";

/**
 * Rendered on `/sourcing/<type>/<id>` when the record exists in its source
 * table but has no `source_check_verdicts` row yet (i.e. unchecked, the common
 * case for wiki-pages, investments, policy-stakeholders, etc.).
 *
 * Previously such URLs returned a raw Next.js 404 (QUA-419).
 */
export function UncheckedSourcingState({
  recordType,
  recordId,
  displayName,
  recordHref,
}: {
  recordType: string;
  recordId: string;
  displayName: string;
  recordHref: string | null;
}) {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link
        href="/sourcing"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All Source Checks
      </Link>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
        <span>{formatRecordType(recordType)}</span>
      </div>
      <h1 className="text-2xl font-bold mb-1">{displayName}</h1>
      <p className="text-sm text-muted-foreground mb-6 font-mono">{recordId}</p>
      <div className="rounded-lg border border-border/60 bg-muted/20 p-6">
        <div className="flex items-start gap-3">
          <CircleHelp className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="space-y-2 text-sm">
            <p className="font-medium">Not yet sourced</p>
            <p className="text-muted-foreground">
              This record exists in the database but has not been run through
              the sourcing pipeline yet. Once sourced, this page will show
              per-source verdicts, evidence, and links to the sources used.
            </p>
            {recordHref && (
              <p className="pt-1">
                <Link
                  href={recordHref}
                  className="text-primary hover:underline"
                >
                  View the record →
                </Link>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
