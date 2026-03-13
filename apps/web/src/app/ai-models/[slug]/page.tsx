import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getTypedEntityById } from "@/data";
import {
  resolveAiModelBySlug,
  getAiModelSlugs,
  getRelatedModels,
} from "../ai-model-utils";
import { Breadcrumbs, ProfileStatCard } from "@/components/directory";

export function generateStaticParams() {
  return getAiModelSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolveAiModelBySlug(slug);
  return {
    title: entity ? `${entity.title} | AI Models` : "AI Model Not Found",
    description: entity?.description ?? undefined,
  };
}

const DEVELOPER_COLORS: Record<string, string> = {
  anthropic:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  openai:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  deepmind:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "meta-ai":
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  "mistral-ai":
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  xai: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  deepseek:
    "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

const SAFETY_LEVEL_COLORS: Record<string, string> = {
  "ASL-1":
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "ASL-2":
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  "ASL-3":
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "ASL-4":
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M tokens`;
  if (tokens >= 1_000) return `${tokens / 1_000}K tokens`;
  return `${tokens} tokens`;
}

function formatPrice(price: number): string {
  return `\$${price}`;
}

export default async function AiModelDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveAiModelBySlug(slug);
  if (!entity) return notFound();

  // Resolve developer
  const developerEntity = entity.developer
    ? getTypedEntityById(entity.developer)
    : null;

  // Related models (same family or developer)
  const relatedModels = getRelatedModels(entity);
  const sameFamily = relatedModels.filter(
    (m) => m.modelFamily && m.modelFamily === entity.modelFamily,
  );
  const sameDeveloper = relatedModels.filter(
    (m) =>
      m.developer === entity.developer &&
      (!m.modelFamily || m.modelFamily !== entity.modelFamily),
  );

  // Is this a family entry?
  const isFamily = !entity.modelTier && !entity.releaseDate;

  // Build stat cards
  const stats: Array<{
    label: string;
    value: string;
    sub?: string;
    href?: string;
  }> = [];

  if (developerEntity) {
    stats.push({
      label: "Developer",
      value: developerEntity.title,
      href: `/organizations/${entity.developer}`,
    });
  }

  if (entity.releaseDate) {
    stats.push({ label: "Released", value: entity.releaseDate });
  }

  if (entity.contextWindow != null) {
    stats.push({
      label: "Context Window",
      value: formatContext(entity.contextWindow),
    });
  }

  if (entity.safetyLevel) {
    stats.push({ label: "Safety Level", value: entity.safetyLevel });
  }

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "AI Models", href: "/ai-models" },
          { label: entity.title },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <h1 className="text-3xl font-extrabold tracking-tight">
            {entity.title}
          </h1>
          {entity.developer && (
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
                DEVELOPER_COLORS[entity.developer] ??
                "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              }`}
            >
              {developerEntity?.title ?? entity.developer}
            </span>
          )}
          {entity.openWeight && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
              Open Weight
            </span>
          )}
          {entity.safetyLevel && (
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold ${
                SAFETY_LEVEL_COLORS[entity.safetyLevel] ??
                "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              }`}
            >
              {entity.safetyLevel}
            </span>
          )}
        </div>

        {entity.description && (
          <p className="text-muted-foreground text-sm max-w-3xl leading-relaxed">
            {entity.description}
          </p>
        )}

        <div className="flex items-center gap-4 mt-3 text-sm">
          {entity.numericId && (
            <Link
              href={`/wiki/${entity.numericId}`}
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Wiki page &rarr;
            </Link>
          )}
          {entity.sources?.length > 0 && entity.sources[0].url && (
            <a
              href={entity.sources[0].url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Source &rarr;
            </a>
          )}
        </div>
      </div>

      {/* Stat cards */}
      {stats.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          {stats.map((s) => (
            <ProfileStatCard key={s.label} {...s} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-8">
          {/* Pricing */}
          {(entity.inputPrice != null || entity.outputPrice != null) && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Pricing
              </h2>
              <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                      <th className="py-2.5 px-4 text-left font-medium">
                        Type
                      </th>
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
          )}

          {/* Benchmarks */}
          {entity.benchmarks.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Benchmarks
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {entity.benchmarks.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                      <th className="py-2.5 px-4 text-left font-medium">
                        Benchmark
                      </th>
                      <th className="py-2.5 px-4 text-right font-medium">
                        Score
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {entity.benchmarks.map((b) => (
                      <tr
                        key={b.name}
                        className="hover:bg-muted/20 transition-colors"
                      >
                        <td className="py-2.5 px-4">{b.name}</td>
                        <td className="py-2.5 px-4 text-right tabular-nums font-semibold">
                          {b.score}
                          {b.unit === "%" ? "%" : b.unit ? ` ${b.unit}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Family models */}
          {sameFamily.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                {entity.modelFamily} Family
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {sameFamily.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                      <th className="py-2.5 px-4 text-left font-medium">
                        Model
                      </th>
                      <th className="py-2.5 px-4 text-left font-medium">
                        Tier
                      </th>
                      <th className="py-2.5 px-4 text-left font-medium">
                        Released
                      </th>
                      <th className="py-2.5 px-4 text-right font-medium">
                        Input $/MTok
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {sameFamily
                      .sort((a, b) =>
                        (b.releaseDate ?? "").localeCompare(
                          a.releaseDate ?? "",
                        ),
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
                            {m.modelTier ?? ""}
                          </td>
                          <td className="py-2.5 px-4 text-muted-foreground">
                            {m.releaseDate ?? ""}
                          </td>
                          <td className="py-2.5 px-4 text-right tabular-nums">
                            {m.inputPrice != null
                              ? formatPrice(m.inputPrice)
                              : ""}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Other models from same developer */}
          {sameDeveloper.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Other {developerEntity?.title ?? "Developer"} Models
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {sameDeveloper.length}
                </span>
              </h2>
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
                          {m.releaseDate ?? ""}
                        </span>
                      </div>
                      {m.modelFamily && (
                        <div className="text-xs text-muted-foreground/60 mt-0.5">
                          {m.modelFamily}{" "}
                          {m.modelTier ? `(${m.modelTier})` : ""}
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

        {/* Sidebar */}
        <div className="space-y-8">
          {/* Model details */}
          <section>
            <h2 className="text-lg font-bold tracking-tight mb-4">Details</h2>
            <div className="border border-border/60 rounded-xl bg-card">
              <DetailRow label="Model Family" value={entity.modelFamily} />
              <DetailRow label="Tier" value={entity.modelTier} capitalize />
              <DetailRow label="Generation" value={entity.generation} />
              <DetailRow label="Release Date" value={entity.releaseDate} />
              <DetailRow
                label="Parameters"
                value={entity.parameterCount}
              />
              <DetailRow
                label="Context Window"
                value={
                  entity.contextWindow != null
                    ? formatContext(entity.contextWindow)
                    : undefined
                }
              />
              <DetailRow
                label="Training Cutoff"
                value={entity.trainingCutoff}
              />
              <DetailRow
                label="Open Weight"
                value={
                  entity.openWeight != null
                    ? entity.openWeight
                      ? "Yes"
                      : "No"
                    : undefined
                }
              />
              <DetailRow label="Safety Level" value={entity.safetyLevel} />
              {entity.modality.length > 0 && (
                <DetailRow
                  label="Modality"
                  value={entity.modality.join(", ")}
                />
              )}
            </div>
          </section>

          {/* Capabilities */}
          {entity.capabilities.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Capabilities
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {entity.capabilities.length}
                </span>
              </h2>
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

          {/* Sources */}
          {entity.sources.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Sources
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {entity.sources.length}
                </span>
              </h2>
              <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
                {entity.sources.map((source, i) => (
                  <div key={`${i}-${source.title}`} className="px-4 py-3">
                    {source.url ? (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium hover:text-primary transition-colors"
                      >
                        {source.title}
                      </a>
                    ) : (
                      <span className="text-sm font-medium">
                        {source.title}
                      </span>
                    )}
                    {source.date && (
                      <div className="text-xs text-muted-foreground/60 mt-0.5">
                        {source.date}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Tags */}
          {entity.tags.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">Tags</h2>
              <div className="flex flex-wrap gap-1.5">
                {entity.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted/50 text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  capitalize,
}: {
  label: string;
  value?: string | null;
  capitalize?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="px-4 py-2.5 border-b border-border/40 last:border-b-0 flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-sm font-medium ${capitalize ? "capitalize" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
