import type { Metadata } from "next";
import { FBEntityCoverageContent } from "../factbase-entities-content";

export const metadata: Metadata = {
  title: "Entity Coverage — FactBase",
  description:
    "See which entities have the most data and which need more coverage.",
};

export default function FactBaseEntityCoveragePage() {
  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight mb-4">
        Entity Coverage
      </h1>
      <FBEntityCoverageContent />
    </div>
  );
}
