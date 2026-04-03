import type { Metadata } from "next";
import { FBRecordsExplorerContent } from "../factbase-records-content";

export const metadata: Metadata = {
  title: "Records Explorer — FactBase",
  description: "Browse all FactBase record collections across entities.",
};

export default function FactBaseRecordsPage() {
  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight mb-4">
        Records Explorer
      </h1>
      <FBRecordsExplorerContent />
    </div>
  );
}
