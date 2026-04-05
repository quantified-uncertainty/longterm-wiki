"use client";

import { Suspense, useState } from "react";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { Database, Layers3 } from "lucide-react";

interface DataViewTabsProps {
  structuredContent: React.ReactNode;
  databaseContent: React.ReactNode;
}

const TABS = [
  { id: "structured", label: "Structured Facts", icon: Layers3 },
  { id: "database", label: "Database Records", icon: Database },
] as const;

function DataViewTabsInner({
  structuredContent,
  databaseContent,
}: DataViewTabsProps) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const tabParam = searchParams.get("tab");
  const activeTab =
    tabParam && TABS.some((t) => t.id === tabParam) ? tabParam : "structured";

  // Lazy-mount: only render the database tab after it's been selected once,
  // so we don't trigger a wiki-server fetch on initial page load.
  const [hasOpenedDatabase, setHasOpenedDatabase] = useState(activeTab === "database");

  function handleTabChange(id: string) {
    if (id === "database" && !hasOpenedDatabase) {
      setHasOpenedDatabase(true);
    }
    if (id === "structured") {
      router.replace(pathname, { scroll: false });
    } else {
      router.replace(`${pathname}?tab=${id}`, { scroll: false });
    }
  }

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 p-1 rounded-lg bg-muted/50 border border-border/50 w-fit mb-8">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`
                flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all cursor-pointer
                ${
                  isActive
                    ? "bg-background text-foreground shadow-sm border border-border/60"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                }
              `}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content — lazy-mount database tab to avoid unnecessary fetch */}
      <div className={`min-h-[400px] ${activeTab === "structured" ? "block" : "hidden"}`}>
        {structuredContent}
      </div>
      {hasOpenedDatabase && (
        <div className={`min-h-[400px] ${activeTab === "database" ? "block" : "hidden"}`}>
          {databaseContent}
        </div>
      )}
    </div>
  );
}

function DataViewTabsFallback({
  structuredContent,
}: Pick<DataViewTabsProps, "structuredContent">) {
  return (
    <div>
      <div className="flex gap-1 p-1 rounded-lg bg-muted/50 border border-border/50 w-fit mb-8">
        {TABS.map((tab, i) => {
          const Icon = tab.icon;
          return (
            <div
              key={tab.id}
              className={`
                flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium
                ${
                  i === 0
                    ? "bg-background text-foreground shadow-sm border border-border/60"
                    : "text-muted-foreground"
                }
              `}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </div>
          );
        })}
      </div>
      {structuredContent}
    </div>
  );
}

export function DataViewTabs(props: DataViewTabsProps) {
  return (
    <Suspense fallback={<DataViewTabsFallback structuredContent={props.structuredContent} />}>
      <DataViewTabsInner {...props} />
    </Suspense>
  );
}
