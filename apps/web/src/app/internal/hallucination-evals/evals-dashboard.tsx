"use client";

import type { BaselineResult } from "./page";

interface Props {
  baselines: BaselineResult[];
}

function ScoreCard({
  label,
  value,
  description,
  color = "default",
}: {
  label: string;
  value: string | number;
  description?: string;
  color?: "default" | "green" | "yellow" | "red";
}) {
  const colorClass =
    color === "green"
      ? "text-green-600 dark:text-green-400"
      : color === "yellow"
        ? "text-yellow-600 dark:text-yellow-400"
        : color === "red"
          ? "text-red-600 dark:text-red-400"
          : "text-foreground";

  return (
    <div className="border rounded-lg p-4 bg-card">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold ${colorClass}`}>{value}</div>
      {description && (
        <div className="text-xs text-muted-foreground mt-1">{description}</div>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mt-8 mb-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function CategoryTable({
  data,
}: {
  data: Record<string, { total: number; caught: number; recall: number }>;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b">
          <th className="text-left py-2 font-medium">Category</th>
          <th className="text-right py-2 font-medium">Total</th>
          <th className="text-right py-2 font-medium">Caught</th>
          <th className="text-right py-2 font-medium">Recall</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(data).map(([cat, d]) => (
          <tr key={cat} className="border-b border-border/50">
            <td className="py-2 font-mono text-xs">{cat}</td>
            <td className="text-right py-2">{d.total}</td>
            <td className="text-right py-2">{d.caught}</td>
            <td className="text-right py-2">
              {(d.recall * 100).toFixed(0)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DetectorTable({
  data,
}: {
  data: Record<
    string,
    { findings: number; truePositives: number; precision: number }
  >;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b">
          <th className="text-left py-2 font-medium">Detector</th>
          <th className="text-right py-2 font-medium">Findings</th>
          <th className="text-right py-2 font-medium">True Positives</th>
          <th className="text-right py-2 font-medium">Precision</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(data).map(([det, d]) => (
          <tr key={det} className="border-b border-border/50">
            <td className="py-2 font-mono text-xs">{det}</td>
            <td className="text-right py-2">{d.findings}</td>
            <td className="text-right py-2">{d.truePositives}</td>
            <td className="text-right py-2">
              {(d.precision * 100).toFixed(0)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AgentFindingsTable({
  data,
}: {
  data: Record<string, { findings: number; notes: string }>;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b">
          <th className="text-left py-2 font-medium">Page</th>
          <th className="text-right py-2 font-medium">Findings</th>
          <th className="text-left py-2 pl-4 font-medium">Notes</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(data).map(([page, d]) => (
          <tr key={page} className="border-b border-border/50">
            <td className="py-2 font-mono text-xs">{page}</td>
            <td className="text-right py-2">{d.findings}</td>
            <td className="py-2 pl-4 text-xs text-muted-foreground max-w-md truncate">
              {d.notes}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EvalsDashboard({ baselines }: Props) {
  if (baselines.length === 0) {
    return (
      <div className="border rounded-lg p-8 text-center text-muted-foreground">
        <p className="text-lg font-medium">No eval results yet</p>
        <p className="mt-2">
          Run <code className="bg-muted px-1 rounded">crux evals run --suite=injection</code> to generate
          baseline results.
        </p>
      </div>
    );
  }

  const latest = baselines[0];
  const injection = latest.suites.injection;
  const crossRef = latest.suites.crossReference;
  const agents = latest.adversarialAgents;

  return (
    <div className="space-y-2">
      {/* Run info */}
      <div className="text-sm text-muted-foreground">
        Latest run: <span className="font-medium">{latest.runDate}</span>
        {baselines.length > 1 && (
          <span className="ml-2">({baselines.length} runs total)</span>
        )}
      </div>

      {/* ── Injection Eval ──────────────────────────────────── */}
      <SectionHeader
        title="Error Injection Eval"
        description="Inject known errors into golden pages, then measure whether detection systems catch them."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <ScoreCard
          label="Errors Injected"
          value={injection.errorsInjected}
          description={`Across ${injection.pages.length} pages`}
        />
        <ScoreCard
          label="Recall"
          value={`${(injection.recall * 100).toFixed(0)}%`}
          description={`${injection.errorsCaught}/${injection.errorsInjected} caught`}
          color={injection.recall > 0.5 ? "green" : injection.recall > 0.2 ? "yellow" : "red"}
        />
        <ScoreCard
          label="Precision"
          value={`${(injection.precision * 100).toFixed(0)}%`}
          color={injection.precision > 0.5 ? "green" : injection.precision > 0.2 ? "yellow" : "red"}
        />
        <ScoreCard
          label="F1 Score"
          value={`${(injection.f1 * 100).toFixed(0)}%`}
          color={injection.f1 > 0.5 ? "green" : injection.f1 > 0.2 ? "yellow" : "red"}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-6 mt-4">
        <div className="border rounded-lg p-4">
          <h3 className="font-medium mb-2">By Error Category</h3>
          <CategoryTable data={injection.byCategory} />
        </div>
        <div className="border rounded-lg p-4">
          <h3 className="font-medium mb-2">By Detector</h3>
          <DetectorTable data={injection.byDetector} />
        </div>
      </div>

      {injection.notes && (
        <div className="bg-muted/50 rounded-lg p-4 text-sm">
          <span className="font-medium">Notes:</span> {injection.notes}
        </div>
      )}

      {/* ── Cross-Reference Check ──────────────────────────── */}
      <SectionHeader
        title="Cross-Reference Consistency"
        description="Extract structured facts across pages, check for contradictions."
      />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <ScoreCard
          label="Pages Scanned"
          value={crossRef.pagesScanned}
        />
        <ScoreCard
          label="Facts Extracted"
          value={crossRef.factsExtracted}
        />
        <ScoreCard
          label="Contradictions"
          value={crossRef.contradictionsFound}
          color={crossRef.contradictionsFound === 0 ? "green" : "red"}
        />
      </div>

      {crossRef.notes && (
        <div className="bg-muted/50 rounded-lg p-4 text-sm mt-4">
          <span className="font-medium">Notes:</span> {crossRef.notes}
        </div>
      )}

      {/* ── Adversarial Agents ─────────────────────────────── */}
      <SectionHeader
        title="Adversarial Agent Findings"
        description="Autonomous agents that crawl real wiki pages looking for hallucination patterns."
      />

      <div className="space-y-4">
        <div className="border rounded-lg p-4">
          <h3 className="font-medium mb-2">Reference Sniffer</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Extracts factual claims, flags uncited specifics (dollar amounts, dates, percentages).
          </p>
          <AgentFindingsTable data={agents.referenceSniffer} />
        </div>

        <div className="border rounded-lg p-4">
          <h3 className="font-medium mb-2">Description Auditor</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Cross-checks entity YAML descriptions against frontmatter and overview sections.
          </p>
          <AgentFindingsTable data={agents.descriptionAuditor} />
        </div>

        <div className="border rounded-lg p-4">
          <h3 className="font-medium mb-2">Cross-Reference Checker</h3>
          <div className="grid grid-cols-2 gap-4">
            <ScoreCard
              label="Pages Scanned"
              value={agents.crossReferenceChecker.pagesScanned}
            />
            <ScoreCard
              label="Contradictions"
              value={agents.crossReferenceChecker.contradictions}
              color={agents.crossReferenceChecker.contradictions === 0 ? "green" : "red"}
            />
          </div>
        </div>
      </div>

      {/* ── Injection Demo ─────────────────────────────────── */}
      {latest.injectionDemo && (
        <>
          <SectionHeader
            title="Injection Examples"
            description="Sample error injections showing what the framework produces."
          />

          <div className="border rounded-lg p-4">
            <div className="text-sm mb-3">
              <span className="font-medium">{latest.injectionDemo.page}</span>
              {" "}&mdash;{" "}
              {latest.injectionDemo.errorsInjected} errors injected across{" "}
              {latest.injectionDemo.categories.length} categories
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 font-medium">Category</th>
                  <th className="text-left py-2 font-medium">Description</th>
                </tr>
              </thead>
              <tbody>
                {latest.injectionDemo.examples.map((ex, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="py-2 font-mono text-xs">{ex.category}</td>
                    <td className="py-2 text-xs">{ex.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── CLI Commands ───────────────────────────────────── */}
      <SectionHeader
        title="CLI Commands"
        description="Run evals from the command line to generate new results."
      />

      <div className="bg-muted rounded-lg p-4 font-mono text-xs space-y-1">
        <div><span className="text-muted-foreground"># Error injection eval</span></div>
        <div>crux evals run --suite=injection --pages=anthropic,miri --verbose</div>
        <div className="mt-2"><span className="text-muted-foreground"># Cross-reference consistency</span></div>
        <div>crux evals run --suite=cross-ref --limit=200</div>
        <div className="mt-2"><span className="text-muted-foreground"># Fake entity resistance (requires API key)</span></div>
        <div>crux evals run --suite=fake-entity</div>
        <div className="mt-2"><span className="text-muted-foreground"># Adversarial agents</span></div>
        <div>crux evals hunt --agent=reference-sniffer --page=anthropic --no-llm</div>
        <div>crux evals hunt --agent=description-auditor --page=miri</div>
        <div className="mt-2"><span className="text-muted-foreground"># Manual error injection</span></div>
        <div>crux evals inject anthropic --count=2</div>
      </div>
    </div>
  );
}
