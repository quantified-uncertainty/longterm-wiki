import { getPrItems } from "@/data";
import { PrDescriptionsTable } from "./pr-descriptions-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PR Descriptions | Longterm Wiki Internal",
  description:
    "Browse all pull requests with their descriptions, status, and metadata.",
};

export default function PrDescriptionsPage() {
  const items = getPrItems();

  const byState: Record<string, number> = {};
  for (const item of items) {
    const state = item.mergedAt ? "merged" : item.state;
    byState[state] = (byState[state] || 0) + 1;
  }

  return (
    <article className="prose max-w-none">
      <h1>PR Descriptions</h1>
      <p className="text-muted-foreground">
        All pull requests with descriptions and metadata.{" "}
        <span className="font-medium text-foreground">{items.length}</span> PRs
        total
        {byState.merged ? (
          <>
            {" "}
            ({" "}
            <span className="font-medium text-foreground">
              {byState.merged}
            </span>{" "}
            merged
            {byState.open ? (
              <>
                ,{" "}
                <span className="font-medium text-foreground">
                  {byState.open}
                </span>{" "}
                open
              </>
            ) : null}
            {byState.closed ? (
              <>
                ,{" "}
                <span className="font-medium text-foreground">
                  {byState.closed}
                </span>{" "}
                closed
              </>
            ) : null}
            )
          </>
        ) : null}
        .
      </p>
      {items.length === 0 ? (
        <p className="text-muted-foreground italic">
          No PR data available. Ensure <code>GITHUB_TOKEN</code> is set during
          build.
        </p>
      ) : (
        <PrDescriptionsTable data={items} />
      )}
    </article>
  );
}
