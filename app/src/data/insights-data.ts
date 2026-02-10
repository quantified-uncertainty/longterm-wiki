// Insights data loader
// Loads insights from multiple YAML files in the insights/ directory
// Ported from cairn: uses fs.readFileSync instead of Vite ?raw imports

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const INSIGHTS_DIR = path.resolve(process.cwd(), '../data/insights');

const INSIGHT_FILES = [
  'quantitative.yaml',
  'claim.yaml',
  'counterintuitive.yaml',
  'research-gap.yaml',
  'disagreement.yaml',
  'neglected.yaml',
];

export type InsightType = 'claim' | 'research-gap' | 'counterintuitive' | 'quantitative' | 'disagreement' | 'neglected';

export type InsightStatus = 'current' | 'needs-review' | 'stale' | 'new';

export interface Insight {
  id: string;
  insight: string;
  source: string;
  tags: string[];
  type: InsightType;
  surprising: number;
  important: number;
  actionable: number;
  neglected: number;
  compact: number;
  added: string;
  composite?: number;
  lastVerified?: string;
  tableRef?: string;
  needsReview?: boolean;
  status?: InsightStatus;
}

interface RawInsightsData {
  insights: Insight[];
}

function computeStatus(insight: Insight): InsightStatus {
  const now = new Date();
  const added = new Date(insight.added);
  const daysSinceAdded = Math.floor((now.getTime() - added.getTime()) / (1000 * 60 * 60 * 24));

  if (insight.needsReview) return 'needs-review';
  if (daysSinceAdded <= 14) return 'new';
  if (!insight.lastVerified && daysSinceAdded > 90) return 'stale';

  if (insight.lastVerified) {
    const verified = new Date(insight.lastVerified);
    const daysSinceVerified = Math.floor((now.getTime() - verified.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSinceVerified > 90) return 'needs-review';
  }

  return 'current';
}

let _insights: Insight[] | null = null;

function loadInsights(): Insight[] {
  if (_insights) return _insights;

  const allInsights: Insight[] = [];
  for (const filename of INSIGHT_FILES) {
    const filePath = path.join(INSIGHTS_DIR, filename);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = yaml.load(content) as RawInsightsData;
    if (data?.insights) {
      allInsights.push(...data.insights);
    }
  }

  _insights = allInsights.map(insight => {
    const processed = {
      ...insight,
      type: insight.type || 'claim',
      actionable: insight.actionable || 3.0,
      neglected: insight.neglected || 3.0,
      composite: Number(((insight.surprising + insight.important + (insight.actionable || 3.0)) / 3).toFixed(2))
    };
    return {
      ...processed,
      status: computeStatus(processed),
    };
  });

  return _insights;
}

export const insights = loadInsights();

export function getInsightsBySource(sourcePath: string): Insight[] {
  return insights.filter(i => i.source === sourcePath);
}

export function getInsightsByTag(tag: string): Insight[] {
  return insights.filter(i => i.tags.includes(tag));
}

export function getAllTags(): string[] {
  const tags = new Set<string>();
  insights.forEach(i => i.tags.forEach(t => tags.add(t)));
  return Array.from(tags).sort();
}

export function getAllTypes(): InsightType[] {
  const types = new Set<InsightType>();
  insights.forEach(i => types.add(i.type));
  return Array.from(types).sort();
}

export function getInsightsByType(type: InsightType): Insight[] {
  return insights.filter(i => i.type === type);
}

export function getInsightsByStatus(status: InsightStatus): Insight[] {
  return insights.filter(i => i.status === status);
}

export function getRecentInsights(days: number = 14): Insight[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return insights.filter(i => new Date(i.added) >= cutoff);
}

export function getInsightsByTable(tableRef: string): Insight[] {
  return insights.filter(i => i.tableRef === tableRef);
}

export function getInsightStats() {
  const total = insights.length;
  const avgSurprising = insights.reduce((sum, i) => sum + i.surprising, 0) / total;
  const avgImportant = insights.reduce((sum, i) => sum + i.important, 0) / total;
  const avgActionable = insights.reduce((sum, i) => sum + i.actionable, 0) / total;
  const avgNeglected = insights.reduce((sum, i) => sum + i.neglected, 0) / total;
  const avgCompact = insights.reduce((sum, i) => sum + i.compact, 0) / total;
  const avgComposite = insights.reduce((sum, i) => sum + (i.composite || 0), 0) / total;

  const byType: Record<string, number> = {};
  insights.forEach(i => {
    byType[i.type] = (byType[i.type] || 0) + 1;
  });

  const byStatus: Record<string, number> = {
    'new': 0,
    'current': 0,
    'needs-review': 0,
    'stale': 0,
  };
  insights.forEach(i => {
    if (i.status) byStatus[i.status] = (byStatus[i.status] || 0) + 1;
  });

  const withTableRef = insights.filter(i => i.tableRef).length;

  return {
    total,
    avgSurprising: avgSurprising.toFixed(2),
    avgImportant: avgImportant.toFixed(2),
    avgActionable: avgActionable.toFixed(2),
    avgNeglected: avgNeglected.toFixed(2),
    avgCompact: avgCompact.toFixed(2),
    avgComposite: avgComposite.toFixed(2),
    byType,
    byStatus,
    withTableRef,
  };
}
