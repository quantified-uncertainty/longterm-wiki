import { getPageRankings } from "@/data";
import { RankingsTable } from "./rankings-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Importance Rankings | Longterm Wiki Internal",
  description:
    "All wiki pages ranked by readership importance and research value.",
};

export default function ImportanceRankingsPage() {
  const items = getPageRankings();

  const withImportance = items.filter((i) => i.importance != null).length;
  const withResearch = items.filter((i) => i.researchImportance != null).length;

  return (
    <article className="prose max-w-none">
      <h1>Importance Rankings</h1>
      <p className="text-muted-foreground">
        All {items.length} ranked pages with both readership importance and
        research value scores.{" "}
        <span className="font-medium text-foreground">{withImportance}</span>{" "}
        have readership scores,{" "}
        <span className="font-medium text-foreground">{withResearch}</span> have
        research scores. Scores are derived from position in ordered rankings
        (see{" "}
        <a href="/internal/importance-ranking" className="no-underline">
          Importance Ranking System
        </a>
        ).
      </p>
      <RankingsTable data={items} />
    </article>
  );
}
