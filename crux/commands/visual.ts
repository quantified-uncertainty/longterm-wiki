/**
 * Visual Command Handlers
 *
 * Specialized pipeline for creating, reviewing, and managing
 * diagrams, charts, Squiggle models, and other visual elements.
 * Runs parallel to the main content pipeline.
 */

import type { ScriptConfig, CommandResult } from '../lib/cli.ts';
import { buildCommands } from '../lib/cli.ts';

const SCRIPTS: Record<string, ScriptConfig> = {
  create: {
    script: 'visual/visual-create.ts',
    description: 'AI-generate a visual for a page (mermaid, squiggle, cause-effect, comparison)',
    passthrough: ['ci', 'type', 'directions', 'dryRun', 'output', 'model'],
    positional: true,
  },
  review: {
    script: 'visual/visual-review.ts',
    description: 'Render and review visuals with puppeteer + AI quality check',
    passthrough: ['ci', 'screenshot', 'fix', 'dryRun', 'verbose'],
    positional: true,
  },
  audit: {
    script: 'visual/visual-audit.ts',
    description: 'Audit visual coverage across wiki pages',
    passthrough: ['ci', 'verbose', 'minWords', 'format'],
  },
  improve: {
    script: 'visual/visual-improve.ts',
    description: 'Improve existing visuals with AI assistance',
    passthrough: ['ci', 'directions', 'dryRun', 'apply', 'model'],
    positional: true,
  },
  embed: {
    script: 'visual/visual-embed.ts',
    description: 'Embed a reusable visual into a page by data reference',
    passthrough: ['ci', 'dryRun', 'apply', 'list'],
    positional: true,
  },
};

export const commands: Record<
  string,
  (args: string[], options: Record<string, unknown>) => Promise<CommandResult>
> = buildCommands(SCRIPTS);

export function getHelp(): string {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(14)} ${config.description}`)
    .join('\n');

  return `
Visual Domain - Diagram, chart & model management

Commands:
${commandList}

Visual Types:
  mermaid         Mermaid flowcharts, pie, timeline, quadrant, etc.
  squiggle        Squiggle probability distributions and models
  cause-effect    CauseEffectGraph interactive causal diagrams
  comparison      ComparisonTable side-by-side tables
  disagreement    DisagreementMap position comparison cards

Options:
  --type=<t>       Visual type (mermaid, squiggle, cause-effect, comparison, disagreement)
  --directions=<d> Specific instructions for generation or improvement
  --output=<path>  Output file path (defaults to .claude/temp/visual/)
  --model=<m>      Model: haiku, sonnet (default: sonnet)
  --screenshot     Take puppeteer screenshot during review
  --fix            Auto-apply suggested fixes during review
  --min-words=<n>  Minimum word count for audit coverage (default: 500)
  --format=<f>     Audit output format: table, json (default: table)
  --dry-run        Preview without writing files
  --apply          Write changes directly to page
  --verbose        Detailed output

Examples:
  crux visual create existential-risk --type mermaid
  crux visual create compute-governance --type squiggle --directions "model compute growth"
  crux visual review alignment-problem --screenshot
  crux visual audit --min-words=800
  crux visual improve existential-risk --directions "simplify the flowchart"
  crux visual embed existential-risk --visual ai-risk-taxonomy
`;
}
