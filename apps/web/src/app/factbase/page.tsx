import type { Metadata } from "next";
import { FBOverviewContent } from "./factbase-overview-content";

export const metadata: Metadata = {
  title: "FactBase",
  description:
    "Structured, sourced facts about entities tracked by the AI safety wiki.",
};

export default function FactBasePage() {
  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight mb-4">FactBase</h1>
      <FBOverviewContent />
    </div>
  );
}
