import React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { cn } from "@lib/utils";
import { Lightbulb, FlaskConical, Target, CheckCircle2, ExternalLink, BookOpen, GraduationCap, MessageSquare, Briefcase } from "lucide-react";
import { EntityTypeIcon, entityTypeConfig } from "./EntityTypeIcon";
import { EntityLink } from "./EntityLink";
import { severityColors, maturityColors, riskCategoryColors } from "./shared/style-config";
import { getEntityTypeHeader, getEntityTypeLabel, getOrgTypeLabel } from "@/data/entity-ontology";
import type { AnyEntityTypeName } from "@/data/entity-type-names";
import type { ExternalLinksData } from "@/data";
import { InfoBoxDescription } from "./InfoBoxDescription";

type LucideIcon = React.ForwardRefExoticComponent<React.SVGProps<SVGSVGElement> & { size?: number | string }>;

/** Entity type string — constrained to known canonical + alias type names */
export type EntityType = AnyEntityTypeName;

export interface ModelRatingsData {
  novelty?: number;
  rigor?: number;
  actionability?: number;
  completeness?: number;
}

export interface InfoBoxProps {
  type: EntityType;
  title?: string;
  image?: string;
  website?: string;
  importance?: number;
  tractability?: number;
  neglectedness?: number;
  uncertainty?: number;
  founded?: string;
  location?: string;
  headcount?: string;
  funding?: string;
  severity?: string;
  likelihood?: string;
  timeframe?: string;
  category?: string;
  maturity?: string;
  relatedSolutions?: { id: string; title: string; type: string; href: string }[];
  affiliation?: string;
  role?: string;
  knownFor?: string;
  customFields?: { label: string; value: string; link?: string }[];
  relatedTopics?: string[];
  relatedEntries?: { id?: string; type: string; title: string; href: string }[];
  ratings?: ModelRatingsData;
  description?: string;
  externalLinks?: ExternalLinksData;
  topFacts?: { label: string; value: string; asOf?: string }[];
  clusters?: string[];
  wordCount?: number;
  backlinkCount?: number;
  // Organization subtype
  orgType?: string;
  // Policy fields
  introduced?: string;
  policyStatus?: string;
  policyAuthor?: string;
  scope?: string;
  // Summary/overview page this entity belongs to
  summaryPage?: { title: string; href: string };
}


const categoryLabels: Record<string, string> = {
  accident: "Accident Risk",
  misuse: "Misuse Risk",
  structural: "Structural Risk",
  epistemic: "Epistemic Risk",
};

const maturityLabels: Record<string, string> = {
  neglected: "Neglected",
  emerging: "Emerging",
  growing: "Growing",
  mature: "Mature",
  established: "Established",
};

function getImportanceColor(value: number): string {
  if (value >= 90) return "#7c3aed";
  if (value >= 70) return "#8b5cf6";
  if (value >= 50) return "#6366f1";
  if (value >= 30) return "#3b82f6";
  return "#94a3b8";
}

const IRREGULAR_PLURALS: Record<string, string> = {
  Person: "People",
  person: "People",
};

function pluralize(label: string): string {
  if (IRREGULAR_PLURALS[label]) return IRREGULAR_PLURALS[label];
  if (label.endsWith("sis")) return label.slice(0, -3) + "ses";
  if (label.endsWith("s") || label.endsWith("x") || label.endsWith("sh") || label.endsWith("ch")) return label + "es";
  if (label.endsWith("y") && !/[aeiou]y$/i.test(label)) return label.slice(0, -1) + "ies";
  return label + "s";
}

function RatingBar({ value, max = 5 }: { value: number; max?: number }) {
  const percentage = (value / max) * 100;
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1.5 bg-muted rounded-sm relative overflow-hidden">
        <div
          className="absolute left-0 top-0 h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-sm"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-[0.7rem] font-semibold text-muted-foreground min-w-[12px] text-right">{value}</span>
    </div>
  );
}

const externalLinkPlatforms: Record<string, { name: string; icon: typeof BookOpen }> = {
  wikipedia: { name: "Wikipedia", icon: BookOpen },
  wikidata: { name: "Wikidata", icon: BookOpen },
  lesswrong: { name: "LessWrong", icon: GraduationCap },
  alignmentForum: { name: "Alignment Forum", icon: GraduationCap },
  eaForum: { name: "EA Forum", icon: MessageSquare },
  stampy: { name: "AI Safety Info", icon: MessageSquare },
  arbital: { name: "Arbital", icon: BookOpen },
  eightyK: { name: "80,000 Hours", icon: Briefcase },
};

function RatingItem({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <div className="grid grid-cols-[16px_1fr_60px] items-center gap-2">
      <Icon size={14} className="text-muted-foreground" />
      <span className="text-xs text-muted-foreground">{label}</span>
      <RatingBar value={value} />
    </div>
  );
}

export function InfoBox({
  type,
  title,
  image,
  website,
  importance,
  tractability,
  neglectedness,
  uncertainty,
  founded,
  location,
  headcount,
  funding,
  severity,
  likelihood,
  timeframe,
  category,
  maturity,
  relatedSolutions,
  affiliation,
  role,
  knownFor,
  customFields,
  relatedTopics,
  relatedEntries,
  ratings,
  description,
  externalLinks,
  topFacts,
  clusters,
  wordCount,
  backlinkCount,
  orgType,
  introduced,
  policyStatus,
  policyAuthor,
  scope,
  summaryPage,
}: InfoBoxProps) {
  const typeInfo = getEntityTypeHeader(type, orgType);

  const fields: { label: string; value: string; link?: string }[] = [];
  if (orgType) {
    fields.push({ label: "Type", value: getOrgTypeLabel(orgType) });
  }
  if (founded) fields.push({ label: "Founded", value: founded });
  if (location) fields.push({ label: "Location", value: location });
  if (headcount) fields.push({ label: "Employees", value: headcount });
  if (funding) fields.push({ label: "Funding", value: funding });
  if (introduced) fields.push({ label: "Introduced", value: introduced });
  if (policyStatus) fields.push({ label: "Status", value: policyStatus });
  if (policyAuthor) fields.push({ label: "Author", value: policyAuthor });
  if (scope) fields.push({ label: "Scope", value: scope });
  if (category) fields.push({ label: "Category", value: categoryLabels[category] || category, link: `/wiki?riskCategory=${category}` });
  if (severity) fields.push({ label: "Severity", value: severity.charAt(0).toUpperCase() + severity.slice(1) });
  if (likelihood) fields.push({ label: "Likelihood", value: likelihood });
  if (timeframe) fields.push({ label: "Timeframe", value: timeframe });
  if (maturity) fields.push({ label: "Maturity", value: maturityLabels[maturity.toLowerCase()] || maturity });
  if (affiliation) fields.push({ label: "Affiliation", value: affiliation });
  if (role) fields.push({ label: "Role", value: role });
  if (knownFor) fields.push({ label: "Known For", value: knownFor });
  if (website) fields.push({ label: "Website", value: website });
  if (customFields) fields.push(...customFields);

  // Lookup helpers for const color maps with string keys
  const lookupHex = (map: Record<string, { hex: string }>, key: string) => map[key]?.hex;

  const catColor = category ? lookupHex(riskCategoryColors, category) : undefined;
  const matColor = maturity ? lookupHex(maturityColors, maturity.toLowerCase()) : undefined;

  const getValueStyle = (label: string): React.CSSProperties | undefined => {
    if (label === "Importance" && importance !== undefined) return { color: getImportanceColor(importance), fontWeight: 600 };
    if (label === "Severity" && severity) return { color: lookupHex(severityColors, severity) || "inherit", fontWeight: 600 };
    if (label === "Category" && catColor) return { color: catColor, fontWeight: 500 };
    if (label === "Maturity" && matColor) return { color: matColor, fontWeight: 500 };
    return undefined;
  };

  // Group related entries by type
  const groupedEntries = relatedEntries?.reduce(
    (acc, entry) => {
      if (!acc[entry.type]) acc[entry.type] = [];
      acc[entry.type].push(entry);
      return acc;
    },
    {} as Record<string, typeof relatedEntries>
  );

  const sortedTypes = groupedEntries ? Object.keys(groupedEntries) : [];
  const hasITN = tractability !== undefined || neglectedness !== undefined || uncertainty !== undefined;

  // External links entries
  const extLinkEntries = externalLinks
    ? (Object.entries(externalLinks) as [string, string | undefined][]).filter(([_, url]) => url)
    : [];

  // Format word count
  const formattedWordCount = wordCount
    ? wordCount >= 1000
      ? `${(wordCount / 1000).toFixed(1).replace(/\.0$/, "")}k words`
      : `${wordCount} words`
    : null;

  return (
    <Card className="wiki-infobox float-right w-[280px] mb-4 ml-6 overflow-visible text-sm max-md:float-none max-md:w-full max-md:ml-0 max-md:mb-6">
      {/* Header */}
      <div className="px-3 py-2.5 text-white rounded-t-lg" style={{ backgroundColor: typeInfo.headerColor }}>
        <span className="block text-[10px] uppercase tracking-wide opacity-90 mb-0.5">{typeInfo.label}</span>
        {title && <h3 className="m-0 text-sm font-semibold leading-tight text-white">{title}</h3>}
      </div>

      {/* Summary Page — "Part of" breadcrumb */}
      {summaryPage && (
        <div className="px-4 py-1.5 border-b border-border bg-muted/30">
          <span className="text-[0.7rem] text-muted-foreground">Part of </span>
          <Link href={summaryPage.href} className="text-[0.7rem] text-accent-foreground no-underline hover:underline font-medium">
            {summaryPage.title}
          </Link>
        </div>
      )}

      {/* Description — expandable if text overflows 3 lines */}
      {description && <InfoBoxDescription description={description} />}

      {/* External Links */}
      {extLinkEntries.length > 0 && (
        <div className="px-4 py-2 border-b border-border">
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {extLinkEntries.map(([platform, url]) => {
              const config = externalLinkPlatforms[platform];
              if (!config || !url) return null;
              const Icon = config.icon;
              return (
                <a
                  key={platform}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors no-underline"
                >
                  <Icon size={12} />
                  <span>{config.name}</span>
                  <ExternalLink size={9} className="opacity-40" />
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* Fields */}
      {fields.length > 0 && (
        <div className="py-2">
          {fields.map((field, index) => {
            const href = field.link || customFields?.find((cf) => cf.label === field.label)?.link;
            return (
              <div key={index} className="flex py-1.5 border-b border-border last:border-b-0 px-4">
                <span className="flex-shrink-0 w-[100px] min-w-[100px] text-muted-foreground font-medium pr-2">
                  {field.label}
                </span>
                <span className="flex-1 text-foreground break-words" style={!href ? getValueStyle(field.label) : undefined}>
                  {field.label === "Website" ? (
                    <a href={field.value} target="_blank" rel="noopener noreferrer" className="text-accent-foreground no-underline hover:underline">
                      {(() => { try { return new URL(field.value).hostname.replace("www.", ""); } catch { return field.value; } })()}
                    </a>
                  ) : href ? (
                    <Link href={href} className="no-underline hover:underline" style={getValueStyle(field.label)}>{field.value}</Link>
                  ) : (
                    field.value
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Solutions */}
      {relatedSolutions && relatedSolutions.length > 0 && (
        <div className="px-4 py-3 border-t border-border">
          <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Solutions</div>
          <div className="flex flex-wrap gap-1.5">
            {relatedSolutions.map((s, i) => (
              <Link key={i} href={s.href} className="inline-block px-2 py-1 bg-emerald-500/15 rounded text-xs text-emerald-500 no-underline hover:bg-emerald-500/25">
                {s.title}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Key Facts */}
      {topFacts && topFacts.length > 0 && (
        <div className="px-4 py-3 border-t border-border">
          <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Key Facts</div>
          <div className="flex flex-col gap-1.5">
            {topFacts.map((fact, i) => (
              <div key={i} className="flex flex-col">
                <div className="flex justify-between items-baseline gap-2">
                  <span className="text-xs text-muted-foreground">{fact.label}</span>
                  <span className="text-xs font-semibold text-foreground text-right">{fact.value}</span>
                </div>
                {fact.asOf && (
                  <span className="text-[0.65rem] text-muted-foreground/60 text-right">as of {fact.asOf}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Related Topics */}
      {relatedTopics && relatedTopics.length > 0 && (
        <div className="px-4 py-3 border-t border-border">
          <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Related Topics</div>
          <div className="flex flex-wrap gap-1.5">
            {relatedTopics.map((topic, i) => (
              <Link
                key={i}
                href={`/wiki?tag=${encodeURIComponent(topic)}`}
                className="inline-block px-2 py-0.5 bg-muted rounded text-xs text-muted-foreground no-underline hover:bg-muted/80 hover:text-foreground transition-colors"
              >
                {topic}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Related Entries */}
      {groupedEntries && sortedTypes.length > 0 && (
        <div className="px-4 py-3 border-t border-border">
          <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground mb-3">Related</div>
          <div className="flex flex-col gap-4">
            {sortedTypes.map((t) => {
              const entries = groupedEntries![t]!;
              const config = entityTypeConfig[t as keyof typeof entityTypeConfig];
              return (
                <div key={t} className="flex flex-col">
                  <div className="flex items-center gap-1 mb-1">
                    {config && <EntityTypeIcon type={t} size="xs" />}
                    <span className="text-muted-foreground font-medium text-[0.65rem] uppercase tracking-tight">
                      {pluralize(getEntityTypeLabel(t))}
                    </span>
                  </div>
                  <div className="pl-[1.125rem] flex flex-wrap gap-1.5">
                    {entries.map((entry, i) => (
                      entry.id ? (
                        <EntityLink key={i} id={entry.id} className="text-xs">{entry.title}</EntityLink>
                      ) : (
                        <Link key={i} href={entry.href} className="inline-flex items-center px-2 py-0.5 bg-muted rounded text-xs text-accent-foreground no-underline transition-colors hover:bg-muted/80">{entry.title}</Link>
                      )
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Ratings */}
      {ratings && Object.values(ratings).some((v) => v !== undefined) && (
        <div className="px-4 py-3 border-t border-border">
          <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Model Quality</div>
          <div className="flex flex-col gap-2">
            {ratings.novelty !== undefined && <RatingItem icon={Lightbulb} label="Novelty" value={ratings.novelty} />}
            {ratings.rigor !== undefined && <RatingItem icon={FlaskConical} label="Rigor" value={ratings.rigor} />}
            {ratings.actionability !== undefined && <RatingItem icon={Target} label="Actionability" value={ratings.actionability} />}
            {ratings.completeness !== undefined && <RatingItem icon={CheckCircle2} label="Completeness" value={ratings.completeness} />}
          </div>
        </div>
      )}


      {/* ITN Framework */}
      {hasITN && (
        <div className="px-4 py-3 border-t border-border">
          <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Prioritization</div>
          <div className="py-2">
            {tractability !== undefined && (
              <div className="flex py-1.5 border-b border-border last:border-b-0">
                <span className="flex-shrink-0 w-[100px] text-muted-foreground font-medium pr-2">Tractability</span>
                <span className="flex-1 text-foreground font-semibold">{tractability}</span>
              </div>
            )}
            {neglectedness !== undefined && (
              <div className="flex py-1.5 border-b border-border last:border-b-0">
                <span className="flex-shrink-0 w-[100px] text-muted-foreground font-medium pr-2">Neglectedness</span>
                <span className="flex-1 text-foreground font-semibold">{neglectedness}</span>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Article Metrics */}
      {(formattedWordCount || backlinkCount) && (
        <div className="px-4 py-2 border-t border-border">
          <span className="text-[0.7rem] text-muted-foreground/70">
            {[formattedWordCount, backlinkCount ? `${backlinkCount} backlinks` : null].filter(Boolean).join(" · ")}
          </span>
        </div>
      )}
    </Card>
  );
}

export default InfoBox;
