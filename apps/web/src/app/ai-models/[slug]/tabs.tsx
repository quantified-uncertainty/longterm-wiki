import Link from "next/link";
import type { AiModelEntity } from "@/data";
import { BenchmarkScorecard } from "@/app/ai-models/[slug]/benchmark-scorecard";
import type { RpcModelSystemCardRow } from "@lib/wiki-server";

/**
 * Per-tab content components for the AI model profile page. Each tab is a
 * pure render function that takes the entity (and any related data) and
 * returns a React node. Tabs without data are filtered out by ProfileTabs
 * via the `count === 0` rule.
 */

function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

export function OverviewTab({ entity }: { entity: AiModelEntity }) {
  const hasContent =
    entity.modality.length > 0 || entity.capabilities.length > 0;

  if (!hasContent) {
    return (
      <div className="border border-border/40 border-dashed rounded-xl px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground/60">
          No additional overview information recorded yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {entity.modality.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Modality
          </h3>
          <p className="text-sm">{entity.modality.join(", ")}</p>
        </section>
      )}

      {entity.capabilities.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Capabilities
            <span className="ml-2 text-xs font-normal text-muted-foreground/70">
              {entity.capabilities.length}
            </span>
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {entity.capabilities.map((cap) => (
              <span
                key={cap}
                className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium border border-border/60 bg-card text-muted-foreground"
              >
                {cap}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function PricingTab({ entity }: { entity: AiModelEntity }) {
  return (
    <section>
      <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="py-2.5 px-4 text-left font-medium">Type</th>
              <th className="py-2.5 px-4 text-right font-medium">
                Price per MTok
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {entity.inputPrice != null && (
              <tr className="hover:bg-muted/20 transition-colors">
                <td className="py-2.5 px-4">Input</td>
                <td className="py-2.5 px-4 text-right tabular-nums font-semibold">
                  {formatPrice(entity.inputPrice)}
                </td>
              </tr>
            )}
            {entity.outputPrice != null && (
              <tr className="hover:bg-muted/20 transition-colors">
                <td className="py-2.5 px-4">Output</td>
                <td className="py-2.5 px-4 text-right tabular-nums font-semibold">
                  {formatPrice(entity.outputPrice)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function BenchmarksTab({ entity }: { entity: AiModelEntity }) {
  return <BenchmarkScorecard benchmarks={entity.benchmarks} modelId={entity.id} />;
}

export function FamilyTab({
  entity,
  sameFamily,
  sameDeveloper,
  developerName,
}: {
  entity: AiModelEntity;
  sameFamily: AiModelEntity[];
  sameDeveloper: AiModelEntity[];
  developerName: string;
}) {
  return (
    <div className="space-y-8">
      {sameFamily.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            {entity.modelFamily} Family
            <span className="ml-2 text-xs font-normal text-muted-foreground/70">
              {sameFamily.length}
            </span>
          </h3>
          <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="py-2.5 px-4 text-left font-medium">Model</th>
                  <th className="py-2.5 px-4 text-left font-medium">Tier</th>
                  <th className="py-2.5 px-4 text-left font-medium">Released</th>
                  <th className="py-2.5 px-4 text-right font-medium">
                    Input $/MTok
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {sameFamily
                  .sort((a, b) =>
                    (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""),
                  )
                  .map((m) => (
                    <tr
                      key={m.id}
                      className="hover:bg-muted/20 transition-colors"
                    >
                      <td className="py-2.5 px-4">
                        <Link
                          href={`/ai-models/${m.id}`}
                          className="font-medium hover:text-primary transition-colors"
                        >
                          {m.title}
                        </Link>
                      </td>
                      <td className="py-2.5 px-4 text-muted-foreground capitalize">
                        {m.modelTier ?? (
                          <span className="text-muted-foreground/40">
                            &mdash;
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-muted-foreground">
                        {m.releaseDate ?? (
                          <span className="text-muted-foreground/40">
                            &mdash;
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums">
                        {m.inputPrice != null ? (
                          formatPrice(m.inputPrice)
                        ) : (
                          <span className="text-muted-foreground/40">
                            &mdash;
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {sameDeveloper.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Other {developerName} Models
            <span className="ml-2 text-xs font-normal text-muted-foreground/70">
              {sameDeveloper.length}
            </span>
          </h3>
          <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
            {sameDeveloper
              .sort((a, b) =>
                (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""),
              )
              .slice(0, 10)
              .map((m) => (
                <div key={m.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={`/ai-models/${m.id}`}
                      className="font-medium text-sm hover:text-primary transition-colors"
                    >
                      {m.title}
                    </Link>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {m.releaseDate ?? (
                        <span className="text-muted-foreground/40">
                          &mdash;
                        </span>
                      )}
                    </span>
                  </div>
                  {m.modelFamily && (
                    <div className="text-xs text-muted-foreground/60 mt-0.5">
                      {m.modelFamily} {m.modelTier ? `(${m.modelTier})` : ""}
                    </div>
                  )}
                </div>
              ))}
            {sameDeveloper.length > 10 && (
              <div className="px-4 py-3 text-center">
                <span className="text-xs text-muted-foreground">
                  Showing 10 of {sameDeveloper.length} models
                </span>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// System Card tab — QUA-702
// Renders a single system_card row (the latest by release_date). When more
// than one card exists for the model, links to the other source URLs are
// surfaced at the bottom so older revisions stay reachable without a full
// per-card sub-page.
// ─────────────────────────────────────────────────────────────────────────

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

function formatFlops(s: number | string | null | undefined): string {
  if (s == null) return "—";
  const n = typeof s === "string" ? Number(s) : s;
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e24) return `${(n / 1e24).toFixed(1)}e24`;
  if (n >= 1e21) return `${(n / 1e21).toFixed(1)}e21`;
  return n.toExponential(1);
}

function waybackUrl(originalUrl: string): string {
  return `https://web.archive.org/web/*/${originalUrl}`;
}

interface SystemCardTabProps {
  cards: RpcModelSystemCardRow[];
  /** Optional override — used when the page exposes a `?card=<id>` selector. */
  selectedCardId?: string;
  /** Slug of the parent ai-model, used to build per-card URLs. */
  modelSlug: string;
}

export function SystemCardTab({ cards, selectedCardId, modelSlug }: SystemCardTabProps) {
  if (cards.length === 0) {
    return (
      <div className="border border-border/40 border-dashed rounded-xl px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground/60">
          No system card extracted yet.
        </p>
      </div>
    );
  }

  // Sort by release_date desc with synced_at as tiebreaker. Null dates sort last.
  const sorted = [...cards].sort((a, b) => {
    const aDate = a.releaseDate ?? "";
    const bDate = b.releaseDate ?? "";
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    return (b.syncedAt ?? "").localeCompare(a.syncedAt ?? "");
  });

  const card =
    (selectedCardId ? sorted.find((c) => c.id === selectedCardId) : undefined) ??
    sorted[0];
  const others = sorted.filter((c) => c.id !== card.id);

  return (
    <div className="space-y-6">
      {/* Header band */}
      <div className="flex flex-wrap items-center gap-2">
        {card.safetyTier && (
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {card.safetyTier}
          </span>
        )}
        {card.safetyFramework && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-muted text-muted-foreground">
            {card.safetyFramework}
          </span>
        )}
        {card.releaseDate && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-muted/60 text-muted-foreground">
            Released {card.releaseDate}
          </span>
        )}
        {card.contextWindowTokens != null && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-muted/60 text-muted-foreground">
            {formatTokens(card.contextWindowTokens)} ctx
          </span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs">
          <a
            href={card.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            View source card
          </a>
          <a
            href={card.waybackSnapshotUrl ?? waybackUrl(card.sourceUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:underline"
            title="Internet Archive snapshot"
          >
            Wayback
          </a>
        </span>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <SystemCardStat
          label="Context window"
          value={
            card.contextWindowTokens != null
              ? `${formatTokens(card.contextWindowTokens)} tokens`
              : null
          }
        />
        <SystemCardStat
          label="Parameters"
          value={
            card.parametersTotal != null
              ? formatNumber(card.parametersTotal)
              : null
          }
          sub={
            card.parametersActive != null
              ? `${formatNumber(card.parametersActive)} active`
              : undefined
          }
        />
        <SystemCardStat label="Training cutoff" value={card.trainingCutoff} />
        <SystemCardStat label="Safety tier" value={card.safetyTier} />
        <SystemCardStat
          label="Modalities"
          value={
            Array.isArray(card.modalitiesIn) && card.modalitiesIn.length > 0
              ? card.modalitiesIn.join(", ")
              : null
          }
        />
        <SystemCardStat
          label="Training compute"
          value={
            card.trainingComputeFlops != null
              ? `${formatFlops(card.trainingComputeFlops)} FLOPs`
              : null
          }
        />
      </div>

      {/* Architecture / fine-tuning policy / channels */}
      {(card.architecture ||
        card.fineTuningPolicy ||
        (Array.isArray(card.deploymentChannels) &&
          card.deploymentChannels.length > 0)) && (
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {card.architecture && (
            <Detail label="Architecture">{card.architecture}</Detail>
          )}
          {card.fineTuningPolicy && (
            <Detail label="Fine-tuning">{card.fineTuningPolicy}</Detail>
          )}
          {Array.isArray(card.deploymentChannels) &&
            card.deploymentChannels.length > 0 && (
              <Detail label="Deployment">
                {card.deploymentChannels.join(", ")}
              </Detail>
            )}
        </section>
      )}

      {/* Safeguards */}
      {card.safeguardsSummary && (
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Safeguards
          </h3>
          <div className="text-sm leading-relaxed border border-border/60 bg-card rounded-xl px-4 py-3 whitespace-pre-wrap">
            {card.safeguardsSummary}
          </div>
        </section>
      )}

      {/* Cited benchmarks */}
      {Array.isArray(card.evalScoresCited) && card.evalScoresCited.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Cited Evaluations
            <span className="ml-2 text-xs font-normal text-muted-foreground/70">
              {card.evalScoresCited.length}
            </span>
          </h3>
          <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="py-2 px-3 text-left font-medium">Benchmark</th>
                  <th className="py-2 px-3 text-right font-medium">Score</th>
                  <th className="py-2 px-3 text-left font-medium">Setup</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {card.evalScoresCited.map((s, i) => (
                  <tr
                    key={`${s.benchmark}-${i}`}
                    className="hover:bg-muted/20 transition-colors"
                  >
                    <td className="py-2 px-3">{s.benchmark}</td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {s.score}
                      {s.metric ? (
                        <span className="text-muted-foreground/60 text-xs ml-1">
                          {s.metric}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 px-3 text-xs text-muted-foreground">
                      {s.setup ?? (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Self-reported by the lab. Cross-check against the{" "}
            <Link href="/benchmarks" className="text-primary hover:underline">
              benchmarks directory
            </Link>{" "}
            for independent runs.
          </p>
        </section>
      )}

      {/* Third-party evals */}
      {Array.isArray(card.thirdPartyEvals) && card.thirdPartyEvals.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Third-Party Evaluations
            <span className="ml-2 text-xs font-normal text-muted-foreground/70">
              {card.thirdPartyEvals.length}
            </span>
          </h3>
          <ul className="border border-border/60 rounded-xl bg-card divide-y divide-border/50">
            {card.thirdPartyEvals.map((e, i) => (
              <li key={`${e.evaluator}-${i}`} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-sm">{e.evaluator}</span>
                  {e.url && (
                    <a
                      href={e.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      Read summary
                    </a>
                  )}
                </div>
                {e.summary && (
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {e.summary}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Other revisions */}
      {others.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Other Cards
            <span className="ml-2 text-xs font-normal text-muted-foreground/70">
              {others.length}
            </span>
          </h3>
          <ul className="text-xs space-y-1.5">
            {others.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <Link
                  href={`/ai-models/${modelSlug}?card=${c.id}#system-card`}
                  className="text-primary hover:underline"
                >
                  {c.version ?? "(unspecified)"}
                  {c.releaseDate ? ` · ${c.releaseDate}` : ""}
                </Link>
                <a
                  href={c.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:underline"
                >
                  source
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Extraction provenance footer */}
      <p className="text-[10px] text-muted-foreground/60 pt-2 border-t border-border/40">
        Extracted{" "}
        {card.extractedAt
          ? new Date(card.extractedAt).toLocaleDateString()
          : "—"}{" "}
        via {card.extractionModel ?? "?"} (extractor{" "}
        {card.extractorVersion ?? "?"}).
      </p>
    </div>
  );
}

function SystemCardStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | null | undefined;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </p>
      <p className="text-sm font-semibold">
        {value ?? <span className="text-muted-foreground/40">—</span>}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-3 bg-card">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </p>
      <p className="text-sm">{children}</p>
    </div>
  );
}
