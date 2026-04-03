import type { Metadata } from "next";
import { FBFactsExplorerContent } from "../factbase-facts-content";

export const metadata: Metadata = {
  title: "Facts Explorer — FactBase",
  description: "Browse and filter all structured facts in the FactBase.",
};

export default function FactBaseFactsPage() {
  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight mb-4">
        Facts Explorer
      </h1>
      <FBFactsExplorerContent />
    </div>
  );
}
