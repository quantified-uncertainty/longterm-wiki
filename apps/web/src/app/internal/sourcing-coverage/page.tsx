import type { Metadata } from "next";
import { SourcingCoverageContent } from "./sourcing-coverage-content";

export const metadata: Metadata = {
  title: "Source Check Coverage",
  description:
    "Data quality and coverage across all record types — sourcing verdicts, entity counts, and accuracy rates.",
  robots: { index: false },
};

export default function SourcingCoveragePage() {
  return (
    <article className="container mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Source Check Coverage</h1>
      <SourcingCoverageContent />
    </article>
  );
}
