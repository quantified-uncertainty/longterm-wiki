import type { Metadata } from "next";
import { getSimilarityGraphData } from "./get-similarity-data";
import { SimilarityGraph } from "./SimilarityGraph";

export const metadata: Metadata = {
  title: "Page Similarity | Longterm Wiki Internal",
  description:
    "Interactive graph showing content similarity between wiki pages.",
};

export default function SimilarityPage() {
  const data = getSimilarityGraphData();

  return (
    <article className="max-w-none">
      <h1 className="text-2xl font-bold mb-1">Page Similarity Graph</h1>
      <p className="text-muted-foreground mb-4">
        Force-directed graph of {data.nodes.length} wiki pages clustered by
        content similarity. Edges represent relatedness scores computed from
        shared entity links, tag overlap, text similarity, and explicit
        relationships. Node size reflects page importance; color indicates entity
        type.
      </p>
      <SimilarityGraph data={data} />
    </article>
  );
}
