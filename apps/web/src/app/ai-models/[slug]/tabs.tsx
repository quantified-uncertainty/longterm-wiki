import Link from "next/link";
import type { AiModelEntity } from "@/data";
import { BenchmarkScorecard } from "./benchmark-scorecard";

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
