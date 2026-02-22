import * as fs from "fs";
import * as path from "path";
import type { Metadata } from "next";
import { EvalsDashboard } from "./evals-dashboard";

export const metadata: Metadata = {
  title: "Hallucination Evals | Longterm Wiki Internal",
  description:
    "Hallucination detection eval results — injection evals, adversarial agents, and cross-reference checks.",
};

// ── Types ──────────────────────────────────────────────────────────────────

export interface BaselineResult {
  runDate: string;
  suites: {
    injection: {
      pages: string[];
      detectors: string[];
      errorsInjected: number;
      errorsCaught: number;
      recall: number;
      precision: number;
      f1: number;
      byCategory: Record<
        string,
        { total: number; caught: number; recall: number }
      >;
      byDetector: Record<
        string,
        { findings: number; truePositives: number; precision: number }
      >;
      notes: string;
    };
    crossReference: {
      pagesScanned: number;
      factsExtracted: number;
      contradictionsFound: number;
      notes: string;
    };
    fakeEntity: {
      status: string;
      notes: string;
    };
  };
  adversarialAgents: {
    referenceSniffer: Record<
      string,
      {
        findings: number;
        allWarnings: boolean;
        noCritical: boolean;
        topCategories: string[];
        notes: string;
      }
    >;
    descriptionAuditor: Record<
      string,
      { findings: number; notes: string }
    >;
    crossReferenceChecker: {
      pagesScanned: number;
      contradictions: number;
      notes: string;
    };
  };
  injectionDemo: {
    page: string;
    errorsPerCategory: number;
    errorsInjected: number;
    categories: string[];
    examples: Array<{ category: string; description: string }>;
  };
}

// ── Data loading ─────────────────────────────────────────────────────────

function loadBaselineResults(): BaselineResult[] {
  const resultsDir = path.join(
    process.cwd(),
    "crux/evals/baselines"
  );

  try {
    const files = fs.readdirSync(resultsDir).filter(
      (f) => f.startsWith("baseline-") && f.endsWith(".json")
    );

    return files
      .map((f) => {
        try {
          const raw = fs.readFileSync(path.join(resultsDir, f), "utf-8");
          return JSON.parse(raw) as BaselineResult;
        } catch {
          return null;
        }
      })
      .filter((r): r is BaselineResult => r !== null)
      .sort((a, b) => b.runDate.localeCompare(a.runDate));
  } catch {
    return [];
  }
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function HallucinationEvalsPage() {
  const baselines = loadBaselineResults();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Hallucination Detection Evals</h1>
        <p className="text-muted-foreground mt-1">
          Eval results from the hallucination detection framework — error
          injection precision/recall, adversarial agent findings, and
          cross-reference consistency checks.
        </p>
      </div>

      <EvalsDashboard baselines={baselines} />
    </div>
  );
}
