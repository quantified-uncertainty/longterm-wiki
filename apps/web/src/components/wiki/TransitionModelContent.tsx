/**
 * TransitionModelContent - Auto-generates page content from entity data
 *
 * Single component that renders all standard sections for AI Transition Model pages:
 * - Current assessment (status level and trend)
 * - Ratings table
 * - Scope definition
 * - Key debates
 * - Warning indicators
 * - Interventions
 * - Influence relationships
 * - Related content links
 *
 * Usage: <TransitionModelContent entityId="tmc-compute" />
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getTypedEntityById, getEntityHref } from '@/data';
import CauseEffectGraph from '@/components/wiki/CauseEffectGraph';
import {
  getFactorScenarioInfluences,
  getScenarioFactorInfluences,
  getScenarioOutcomeConnections,
} from '@/data/parameter-graph-data';
import { FactorStatusCard } from './FactorStatusCard';
import { InterventionsCard } from './InterventionsCard';
import { EstimatesCard } from './EstimatesCard';
import { WarningIndicatorsCard } from './WarningIndicatorsCard';
import { Backlinks } from './Backlinks';
import { MermaidDiagram } from './MermaidDiagram';

// Types for TMC entity data
interface TMCRatings {
  changeability?: number;
  xriskImpact?: number;
  trajectoryImpact?: number;
  uncertainty?: number;
}

interface TMCKeyDebate {
  topic: string;
  description: string;
}

interface TMCRelatedContentLink {
  path: string;
  title: string;
}

interface TMCRelatedContent {
  risks?: TMCRelatedContentLink[];
  responses?: TMCRelatedContentLink[];
  models?: TMCRelatedContentLink[];
  cruxes?: TMCRelatedContentLink[];
  researchReports?: TMCRelatedContentLink[];
}

interface TMCCurrentAssessment {
  level: number;
  trend: 'improving' | 'stable' | 'declining' | 'unknown';
  confidence?: number;
  lastUpdated?: string;
  notes?: string;
}

interface TMCAddressedBy {
  id?: string;
  path?: string;
  title?: string;
  effect: 'positive' | 'negative' | 'mixed';
  strength?: 'strong' | 'medium' | 'weak';
}

interface TMCWarningIndicator {
  indicator: string;
  status: string;
  trend?: 'improving' | 'stable' | 'worsening';
  concern?: 'low' | 'medium' | 'high';
}

interface TMCEstimate {
  source: string;
  probability: number;
  confidence?: [number, number];
  asOf?: string;
  url?: string;
}

// Cause-Effect Graph types
interface TMCCauseEffectNode {
  id: string;
  label: string;
  description?: string;
  type: 'cause' | 'intermediate' | 'effect';
  confidence?: number;
  details?: string;
  sources?: string[];
  relatedConcepts?: string[];
  entityRef?: string;
}

interface TMCCauseEffectEdge {
  id?: string;
  source: string;
  target: string;
  strength?: 'weak' | 'medium' | 'strong';
  confidence?: 'low' | 'medium' | 'high';
  effect?: 'increases' | 'decreases' | 'mixed';
  label?: string;
}

interface TMCCauseEffectGraph {
  title?: string;
  description?: string;
  primaryNodeId?: string;  // ID of the node representing this entity (highlighted)
  nodes: TMCCauseEffectNode[];
  edges: TMCCauseEffectEdge[];
}

// Content table for YAML-first architecture
interface TMCContentTable {
  headers: string[];
  rows: string[][];
  caption?: string;
}

// Content section for YAML-first architecture
interface TMCContentSection {
  heading: string;
  body?: string;
  mermaid?: string;
  table?: TMCContentTable;
  component?: string;
  componentProps?: Record<string, unknown>;
}

// Rich content for YAML-first architecture
interface TMCContent {
  intro?: string;
  sections?: TMCContentSection[];
  footer?: string;
}

// Extended entity type for TMC entities
interface TMCEntity {
  id: string;
  type: string;
  title: string;
  description?: string;
  parentFactor?: string;
  path?: string;
  ratings?: TMCRatings;
  scope?: string;
  keyDebates?: TMCKeyDebate[];
  relatedContent?: TMCRelatedContent;
  currentAssessment?: TMCCurrentAssessment;
  addressedBy?: TMCAddressedBy[];
  warningIndicators?: TMCWarningIndicator[];
  estimates?: TMCEstimate[];
  causeEffectGraph?: TMCCauseEffectGraph;
  content?: TMCContent;  // YAML-first: Rich prose content stored in YAML
}

interface TransitionModelContentProps {
  // Primary: Provide entityId (e.g., "tmc-compute")
  entityId?: string;
  // Legacy: slug is converted to tmc-{slug} for backward compatibility
  slug?: string;
  // Control what sections to show
  showRatings?: boolean;
  showScope?: boolean;
  showDebates?: boolean;
  showRelated?: boolean;
  showInfluences?: boolean;
  showDescription?: boolean;
  // Extended schema sections
  showCurrentAssessment?: boolean;
  showInterventions?: boolean;
  showEstimates?: boolean;
  showWarningIndicators?: boolean;
  showCauseEffectGraph?: boolean;
  // YAML-first content sections
  showContent?: boolean;
  // Show backlinks at bottom
  showBacklinks?: boolean;
}

function RatingsSection({ ratings }: { ratings: TMCRatings }) {
  const metrics = [
    { key: 'changeability' as const, label: 'Changeability', desc: (v: number) => v <= 33 ? 'Very difficult to influence' : v <= 66 ? 'Moderately changeable' : 'Relatively tractable' },
    { key: 'xriskImpact' as const, label: 'X-risk Impact', desc: (v: number) => v <= 33 ? 'Low direct x-risk impact' : v <= 66 ? 'Moderate x-risk impact' : 'High direct x-risk impact' },
    { key: 'trajectoryImpact' as const, label: 'Trajectory Impact', desc: (v: number) => v <= 33 ? 'Low long-term effects' : v <= 66 ? 'Moderate long-term effects' : 'High long-term effects' },
    { key: 'uncertainty' as const, label: 'Uncertainty', desc: (v: number) => v <= 33 ? 'Lower uncertainty' : v <= 66 ? 'Moderate uncertainty' : 'High uncertainty' },
  ];

  return (
    <div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">Metric</th>
            <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">Score</th>
            <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">Interpretation</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map(({ key, label, desc }) => {
            const value = ratings[key];
            if (value === undefined) return null;
            return (
              <tr key={key}>
                <td className="py-2 px-3 text-left border-b border-border last:border-b-0 font-medium">{label}</td>
                <td className="py-2 px-3 text-left border-b border-border last:border-b-0 font-mono text-primary">{value}/100</td>
                <td className="py-2 px-3 text-left border-b border-border last:border-b-0 text-muted-foreground">{desc(value)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ScopeSection({ scope }: { scope: string }) {
  const lines = scope.split('\n').filter(line => line.trim());
  const includes: string[] = [];
  const excludes: string[] = [];
  let currentSection: 'includes' | 'excludes' | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith('includes:')) {
      currentSection = 'includes';
      const content = trimmed.slice('includes:'.length).trim();
      if (content) includes.push(content);
    } else if (trimmed.toLowerCase().startsWith('excludes:')) {
      currentSection = 'excludes';
      const content = trimmed.slice('excludes:'.length).trim();
      if (content) excludes.push(content);
    } else if (currentSection === 'includes') {
      includes.push(trimmed);
    } else if (currentSection === 'excludes') {
      excludes.push(trimmed);
    }
  }

  if (includes.length === 0 && excludes.length === 0) return null;

  return (
    <div>
      <h3 className="text-lg font-semibold mb-3 text-foreground">Scope</h3>
      {includes.length > 0 && (
        <div className="mb-3 last:mb-0">
          <strong>Includes:</strong>
          <ul className="mt-1 ml-5 list-disc">
            {includes.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
      {excludes.length > 0 && (
        <div className="mb-3 last:mb-0">
          <strong>Excludes:</strong>
          <ul className="mt-1 ml-5 list-disc">
            {excludes.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function DebatesSection({ debates }: { debates: TMCKeyDebate[] }) {
  if (debates.length === 0) return null;

  return (
    <div>
      <h3 className="text-lg font-semibold mb-3 text-foreground">Key Debates</h3>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">Debate</th>
            <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">Core Question</th>
          </tr>
        </thead>
        <tbody>
          {debates.map((debate, i) => (
            <tr key={i}>
              <td className="py-2 px-3 text-left border-b border-border last:border-b-0 font-medium">{debate.topic}</td>
              <td className="py-2 px-3 text-left border-b border-border last:border-b-0">{debate.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RelatedContentSection({ related }: { related: TMCRelatedContent }) {
  // Separate research reports from other content for special treatment
  const researchReports = related.researchReports || [];

  const sections = [
    { key: 'risks' as const, label: 'Related Risks', icon: '' },
    { key: 'responses' as const, label: 'Related Responses', icon: '' },
    { key: 'models' as const, label: 'Related Models', icon: '' },
    { key: 'cruxes' as const, label: 'Related Cruxes', icon: '' },
  ];

  const hasOtherContent = sections.some(s => related[s.key]?.length);
  const hasResearchReports = researchReports.length > 0;

  if (!hasOtherContent && !hasResearchReports) return null;

  return (
    <div>
      {/* Research Reports displayed prominently as cards */}
      {hasResearchReports && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3 text-foreground">Research Report</h3>
          {researchReports.map((report, i) => (
            <a key={i} href={report.path} className="flex items-center gap-4 px-5 py-4 bg-primary/5 border border-primary/30 rounded-xl no-underline transition-all hover:-translate-y-0.5 hover:shadow-md hover:border-primary/50">
              <div className="text-[1.75rem] shrink-0">📄</div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-foreground text-base mb-0.5">{report.title}</div>
                <div className="text-sm text-muted-foreground leading-snug">
                  In-depth analysis with citations, causal factors, and open questions
                </div>
              </div>
              <div className="text-xl text-primary shrink-0 transition-transform hover:translate-x-1">&rarr;</div>
            </a>
          ))}
        </div>
      )}

      {/* Other related content in grid */}
      {hasOtherContent && (
        <>
          <h3 className="text-lg font-semibold mb-3 text-foreground">Related Content</h3>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
            {sections.map(({ key, label, icon }) => {
              const items = related[key];
              if (!items?.length) return null;
              return (
                <div key={key}>
                  <h4 className="text-sm font-semibold mb-2">{icon} {label}</h4>
                  <ul className="list-disc pl-4">
                    {items.map((item, i) => (
                      <li key={i}>
                        <a href={item.path} className="text-primary hover:underline">{item.title}</a>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function InfluencesSection({ parentFactor }: { parentFactor: string }) {
  // Use parentFactor to determine which influences to show
  // For factors (cause nodes), show scenarios influenced
  // For scenarios (intermediate nodes), show factors that influence and outcomes affected

  // Try as a factor first (cause node)
  const factorInfluences = getFactorScenarioInfluences(parentFactor);
  if (factorInfluences.length > 0) {
    return (
      <div>
        <h3 className="text-lg font-semibold mb-3 text-foreground">Scenarios Influenced</h3>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">Scenario</th>
              <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">Effect</th>
              <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">Strength</th>
            </tr>
          </thead>
          <tbody>
            {factorInfluences.map((inf, i) => (
              <tr key={i}>
                <td className="py-2 px-3 text-left border-b border-border last:border-b-0">
                  <a href={getEntityHref(inf.scenarioId)} className="text-primary hover:underline">
                    {inf.scenarioLabel}
                  </a>
                </td>
                <td className="py-2 px-3 text-left border-b border-border last:border-b-0">{inf.effect === 'increases' ? '\u2191 Increases' : inf.effect === 'decreases' ? '\u2193 Decreases' : '\u2014'}</td>
                <td className="py-2 px-3 text-left border-b border-border last:border-b-0">{inf.strength || '\u2014'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Try as a scenario (intermediate node)
  const scenarioFactorInfluences = getScenarioFactorInfluences(parentFactor);
  const outcomeConnections = getScenarioOutcomeConnections(parentFactor);

  if (scenarioFactorInfluences.length > 0 || outcomeConnections.length > 0) {
    return (
      <>
        {scenarioFactorInfluences.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold mb-3 text-foreground">Influenced By</h3>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">Factor</th>
                  <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">Effect</th>
                  <th className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">Strength</th>
                </tr>
              </thead>
              <tbody>
                {scenarioFactorInfluences.map((inf, i) => (
                  <tr key={i}>
                    <td className="py-2 px-3 text-left border-b border-border last:border-b-0">
                      <a href={getEntityHref(inf.factorId)} className="text-primary hover:underline">
                        {inf.factorLabel}
                      </a>
                    </td>
                    <td className="py-2 px-3 text-left border-b border-border last:border-b-0">{inf.effect === 'increases' ? '\u2191 Increases' : inf.effect === 'decreases' ? '\u2193 Decreases' : '\u2014'}</td>
                    <td className="py-2 px-3 text-left border-b border-border last:border-b-0">{inf.strength || '\u2014'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {outcomeConnections.length > 0 && (
          <div>
            <h3 className="text-lg font-semibold mb-3 text-foreground">Outcomes Affected</h3>
            <ul className="list-disc pl-5">
              {outcomeConnections.map((conn, i) => (
                <li key={i}>
                  <a href={getEntityHref(conn.outcomeId)} className="text-primary hover:underline">
                    {conn.outcomeLabel}
                  </a>
                  {conn.effect && (
                    <span className="text-muted-foreground ml-1">
                      {conn.effect === 'increases' ? ' \u2191' : conn.effect === 'decreases' ? ' \u2193' : ''}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }

  return null;
}

/**
 * Preprocesses markdown content from YAML to handle JSX components
 * that were migrated from MDX files. ReactMarkdown doesn't process JSX,
 * so we convert them to markdown equivalents or strip them.
 */
function preprocessYamlContent(content: string): string {
  let result = content;

  // Convert <R id="...">text</R> to markdown links
  // Matches: <R id="abc123">Link Text</R>
  result = result.replace(/<R\s+id="([^"]+)"[^>]*>([^<]+)<\/R>/g, '[$2](/browse/resources/$1/)');

  // Remove self-closing JSX components that shouldn't be in YAML content
  // DataInfoBox, ImpactList, FactorRelationshipDiagram, ParameterDistinctions
  result = result.replace(/<(DataInfoBox|ImpactList|FactorRelationshipDiagram|ParameterDistinctions)[^>]*\/>/g, '');

  // Remove JSX components with client:load directive (these were MDX-specific)
  // Matches: <ComponentName ... client:load /> or <ComponentName ... client:load>...</ComponentName>
  result = result.replace(/<(ATMPage|ImpactList|FactorRelationshipDiagram)[^>]*client:load[^>]*>[\s\S]*?<\/\1>/g, '');
  result = result.replace(/<(ATMPage|ImpactList|FactorRelationshipDiagram)[^>]*client:load[^>]*\/>/g, '');

  // Remove orphaned opening JSX tags (migration errors where only opening tag remains)
  // Matches: <ComponentName ...> at start or on its own line
  result = result.replace(/^\s*<[A-Z][a-zA-Z]*[^/>]*>\s*$/gm, '');

  // Remove any remaining self-closing components that look like JSX (capitalized)
  result = result.replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, '');

  // Clean up any double blank lines left after removing components
  result = result.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace
  result = result.trim();

  return result;
}

/**
 * Fixes markdown tables that were broken by YAML multiline folding.
 * YAML multiline strings can add extra newlines/indentation that break tables.
 * This function:
 * 1. Identifies table rows (lines starting and ending with |)
 * 2. Removes blank lines between table rows
 * 3. Handles YAML folding that splits rows across lines
 */
function fixMarkdownTables(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];
  let tableBuffer: string[] = [];
  let pendingBlankLines = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();
    const isTableRow = trimmedLine.startsWith('|') && trimmedLine.endsWith('|');
    const isSeparator = /^\|[-:|]+\|$/.test(trimmedLine);

    if (isTableRow || isSeparator) {
      // This is a table row - add to buffer (skip any pending blank lines)
      tableBuffer.push(trimmedLine);
      pendingBlankLines = 0;
    } else if (trimmedLine === '' && tableBuffer.length > 0) {
      // Blank line while in a potential table - defer decision
      pendingBlankLines++;
    } else {
      // Non-table line - flush any buffered table
      if (tableBuffer.length > 0) {
        result.push(...tableBuffer);
        tableBuffer = [];
      }
      // Add any pending blank lines for non-table content
      for (let i = 0; i < pendingBlankLines; i++) {
        result.push('');
      }
      pendingBlankLines = 0;
      result.push(line);
    }
  }

  // Flush any remaining table
  if (tableBuffer.length > 0) {
    result.push(...tableBuffer);
  }

  return result.join('\n');
}

/**
 * Renders a single content section from YAML content structure.
 * Supports markdown body, mermaid diagrams, and tables.
 */
function ContentSectionRenderer({ section }: { section: TMCContentSection }) {
  return (
    <div>
      <h2 className="text-xl font-semibold mt-6 mb-3 text-foreground border-b border-border pb-2 first:mt-0">{section.heading}</h2>

      {/* Mermaid diagram */}
      {section.mermaid && (
        <div className="my-4">
          <MermaidDiagram chart={section.mermaid} />
        </div>
      )}

      {/* Table */}
      {section.table && (
        <div className="my-4">
          <table className="w-full border-collapse text-sm [&_p]:m-0">
            <thead>
              <tr>
                {section.table.headers.map((header, i) => (
                  <th key={i} className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b border-border">
                    <ReactMarkdown>{header}</ReactMarkdown>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.table.rows.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} className="py-2 px-3 text-left border-b border-border">
                      <ReactMarkdown>{cell}</ReactMarkdown>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {section.table.caption && (
            <p className="text-sm text-muted-foreground italic text-center mt-2">{section.table.caption}</p>
          )}
        </div>
      )}

      {/* Markdown body */}
      {section.body && (
        <div className="leading-relaxed [&_p]:mb-4 [&_ul]:my-2 [&_ul]:ml-6 [&_ol]:my-2 [&_ol]:ml-6 [&_a]:text-primary [&_a]:hover:underline [&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_th]:border [&_th]:border-border [&_th]:py-2 [&_th]:px-3 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-muted [&_td]:border [&_td]:border-border [&_td]:py-2 [&_td]:px-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{fixMarkdownTables(preprocessYamlContent(section.body))}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

/**
 * Renders the full content structure from YAML.
 * Includes intro, sections, and footer.
 */
function ContentRenderer({ content }: { content: TMCContent }) {
  return (
    <div className="flex flex-col gap-6">
      {/* Intro paragraphs */}
      {content.intro && (
        <div className="text-base leading-relaxed [&_p]:mb-4 [&_p:last-child]:mb-0 [&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_th]:border [&_th]:border-border [&_th]:py-2 [&_th]:px-3 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-muted [&_td]:border [&_td]:border-border [&_td]:py-2 [&_td]:px-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{fixMarkdownTables(preprocessYamlContent(content.intro))}</ReactMarkdown>
        </div>
      )}

      {/* Content sections */}
      {content.sections?.map((section, i) => (
        <ContentSectionRenderer key={i} section={section} />
      ))}

      {/* Footer */}
      {content.footer && (
        <div className="mt-4 pt-4 border-t border-border [&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_th]:border [&_th]:border-border [&_th]:py-2 [&_th]:px-3 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-muted [&_td]:border [&_td]:border-border [&_td]:py-2 [&_td]:px-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{fixMarkdownTables(preprocessYamlContent(content.footer))}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

export function TransitionModelContent({
  entityId,
  slug,
  showRatings = true,
  showScope = true,
  showDebates = true,
  showRelated = true,
  showInfluences = true,
  showDescription = false,
  showCurrentAssessment = true,
  showInterventions = true,
  showEstimates = true,
  showWarningIndicators = true,
  showCauseEffectGraph = true,
  showContent = true,
  showBacklinks = true,
}: TransitionModelContentProps) {
  // Support legacy slug prop by converting to tmc-{slug}
  let effectiveEntityId = entityId;
  if (!effectiveEntityId && slug) {
    effectiveEntityId = `tmc-${slug}`;
  }

  if (!effectiveEntityId) {
    return <div className="p-4 bg-destructive/10 border border-destructive rounded-lg text-destructive">No entityId provided. Use entityId="tmc-compute" format.</div>;
  }

  // Direct entity lookup from database — use typed lookup to preserve TMC fields
  const rawEntity = getTypedEntityById(effectiveEntityId);

  if (!rawEntity) {
    return <div className="p-4 bg-destructive/10 border border-destructive rounded-lg text-destructive">No entity found for ID &quot;{effectiveEntityId}&quot;. Ensure the entity exists in ai-transition-model.yaml.</div>;
  }

  // Cast to TMC entity type for TypeScript
  const entity = rawEntity as unknown as TMCEntity;

  return (
    <div className="flex flex-col gap-6">
      {showDescription && entity.description && (
        <div>
          <p>{entity.description}</p>
        </div>
      )}

      {/* YAML-first content sections (intro + sections + footer) */}
      {showContent && entity.content && (
        <ContentRenderer content={entity.content} />
      )}

      {/* Current Assessment - shows status level and trend */}
      {showCurrentAssessment && entity.currentAssessment && (
        <FactorStatusCard assessment={entity.currentAssessment} />
      )}

      {showRatings && entity.ratings && <RatingsSection ratings={entity.ratings} />}

      {showScope && entity.scope && <ScopeSection scope={entity.scope} />}

      {showDebates && entity.keyDebates && entity.keyDebates.length > 0 && (
        <DebatesSection debates={entity.keyDebates} />
      )}

      {/* Cause-Effect Graph */}
      {showCauseEffectGraph && entity.causeEffectGraph && entity.causeEffectGraph.nodes?.length > 0 && (() => {
        const graph = entity.causeEffectGraph!;
        const layerCount = new Set(graph.nodes.map((n: TMCCauseEffectNode) => n.type)).size;
        const graphHeight = Math.min(800, Math.max(400, 100 + (layerCount * 150)));
        return (
          <div>
            {graph.title && <h3 className="text-lg font-semibold mb-3 text-foreground">{graph.title}</h3>}
            {graph.description && (
              <p className="text-sm text-muted-foreground mb-4">{graph.description}</p>
            )}
            <CauseEffectGraph
              height={graphHeight}
              hideListView={true}
              selectedNodeId={graph.primaryNodeId}
              entityId={effectiveEntityId}
              graphConfig={{
                hideGroupBackgrounds: true,
                useDagre: true,
                typeLabels: {
                  leaf: 'Root Causes',
                  cause: 'Derived',
                  intermediate: 'Direct Factors',
                  effect: 'Target',
                },
              }}
              initialNodes={graph.nodes.map((node: TMCCauseEffectNode) => ({
                id: node.id,
                type: 'causeEffect' as const,
                position: { x: 0, y: 0 },
                data: {
                  label: node.label,
                  description: node.description || '',
                  type: node.type,
                  ...(node.confidence !== undefined && { confidence: node.confidence }),
                  details: node.details || '',
                  sources: node.sources || [],
                  relatedConcepts: node.relatedConcepts || [],
                },
              }))}
              initialEdges={graph.edges.map((edge: TMCCauseEffectEdge) => ({
                id: edge.id || `e-${edge.source}-${edge.target}`,
                source: edge.source,
                target: edge.target,
                data: {
                  strength: edge.strength || 'medium',
                  confidence: edge.confidence || 'medium',
                  effect: edge.effect || 'increases',
                },
                label: edge.label,
              }))}
            />
          </div>
        );
      })()}

      {/* Probability Estimates (primarily for scenarios) */}
      {showEstimates && entity.estimates && entity.estimates.length > 0 && (
        <EstimatesCard estimates={entity.estimates} />
      )}

      {/* Warning Indicators */}
      {showWarningIndicators && entity.warningIndicators && entity.warningIndicators.length > 0 && (
        <WarningIndicatorsCard indicators={entity.warningIndicators} />
      )}

      {/* Interventions that address this factor */}
      {showInterventions && entity.addressedBy && entity.addressedBy.length > 0 && (
        <InterventionsCard interventions={entity.addressedBy as any} />
      )}

      {/* Show influences based on parentFactor */}
      {showInfluences && entity.parentFactor && (
        <InfluencesSection parentFactor={entity.parentFactor} />
      )}

      {showRelated && entity.relatedContent && <RelatedContentSection related={entity.relatedContent} />}

      {/* Backlinks section */}
      {showBacklinks && effectiveEntityId && (
        <>
          <hr className="border-0 border-t border-border my-4" />
          <Backlinks entityId={effectiveEntityId.replace(/^tmc-/, '')} />
        </>
      )}
    </div>
  );
}

export default TransitionModelContent;
