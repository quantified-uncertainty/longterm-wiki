import type { Metadata } from "next";
import { SourceCheckCoverageContent } from "./source-check-coverage-content";

export const metadata: Metadata = {
  title: "Source Check Coverage",
  description:
    "Data quality and coverage across all record types — verification verdicts, entity counts, and accuracy rates.",
  robots: { index: false },
};

export default function SourceCheckCoveragePage() {
  return (
    <article className="container mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Source Check Coverage</h1>
      <SourceCheckCoverageContent />
    </article>
  );
}
