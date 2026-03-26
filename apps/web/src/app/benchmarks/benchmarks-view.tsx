"use client";

import { useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { BenchmarksTable, type BenchmarkRow } from "@/app/benchmarks/benchmarks-table";
import {
  ComparisonMatrix,
  type MatrixBenchmark,
  type MatrixModel,
  type ScoreGrid,
} from "@/app/benchmarks/comparison-matrix";

type ViewMode = "directory" | "matrix";

interface Props {
  rows: BenchmarkRow[];
  matrixBenchmarks: MatrixBenchmark[];
  matrixModels: MatrixModel[];
  matrixScores: ScoreGrid;
}

export function BenchmarksView({
  rows,
  matrixBenchmarks,
  matrixModels,
  matrixScores,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const viewParam = searchParams.get("view");
  const view: ViewMode = viewParam === "matrix" ? "matrix" : "directory";

  const setView = useCallback(
    (next: ViewMode) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "matrix") {
        params.set("view", "matrix");
      } else {
        params.delete("view");
      }
      const query = params.toString();
      router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return (
    <div>
      {/* View toggle */}
      <div className="flex items-center gap-1 mb-5 p-1 bg-muted/30 rounded-lg border border-border/60 w-fit">
        <button
          onClick={() => setView("directory")}
          className={`text-xs px-3 py-1.5 rounded-md transition-all ${
            view === "directory"
              ? "bg-background shadow-sm font-semibold text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Directory
        </button>
        <button
          onClick={() => setView("matrix")}
          className={`text-xs px-3 py-1.5 rounded-md transition-all ${
            view === "matrix"
              ? "bg-background shadow-sm font-semibold text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Comparison Matrix
        </button>
      </div>

      {view === "directory" ? (
        <BenchmarksTable rows={rows} />
      ) : (
        <ComparisonMatrix
          benchmarks={matrixBenchmarks}
          models={matrixModels}
          scores={matrixScores}
        />
      )}
    </div>
  );
}
