import type { Metadata } from "next";
import { FBPropertiesExplorerContent } from "../factbase-properties-content";

export const metadata: Metadata = {
  title: "Properties — FactBase",
  description: "View all property definitions with usage stats and coverage.",
};

export default function FactBasePropertiesPage() {
  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight mb-4">
        Properties
      </h1>
      <FBPropertiesExplorerContent />
    </div>
  );
}
