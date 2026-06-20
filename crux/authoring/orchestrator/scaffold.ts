/**
 * Scaffold Generator for Create Mode
 *
 * Generates a minimal MDX template page that the orchestrator fills in
 * via rewrite_section calls. The scaffold provides section headings that
 * the orchestrator's split_into_sections tool can parse.
 */

/** Template section configs by entity type. */
const ENTITY_SECTIONS: Record<string, string[]> = {
  person: [
    'Quick Assessment',
    'Key Links',
    'Overview',
    'Background and Career',
    'Key Work and Contributions',
    'Views and Positions',
    'Criticisms and Concerns',
    'Key Uncertainties',
  ],
  organization: [
    'Quick Assessment',
    'Key Links',
    'Overview',
    'History',
    'Activities and Products',
    'Funding and Financials',
    'People',
    'Criticisms and Concerns',
    'Key Uncertainties',
  ],
  concept: [
    'Overview',
    'Background',
    'Key Ideas',
    'Applications and Examples',
    'Criticisms and Limitations',
    'Key Uncertainties',
  ],
  risk: [
    'Quick Assessment',
    'Overview',
    'Risk Assessment',
    'Mechanisms',
    'Responses and Mitigations',
    'Key Uncertainties',
  ],
  approach: [
    'Overview',
    'Background',
    'How It Works',
    'Applications',
    'Strengths and Limitations',
    'Key Uncertainties',
  ],
  default: [
    'Quick Assessment',
    'Overview',
    'Background',
    'Key Details',
    'Criticisms and Concerns',
    'Key Uncertainties',
  ],
};

/**
 * Generate a scaffold MDX page for the orchestrator to fill in.
 *
 * @param topic - Page title
 * @param entityType - Entity type (person, organization, concept, etc.)
 * @param wikiId - Optional allocated wiki ID (e.g., "E1234")
 */
export function generateCreateScaffold(
  topic: string,
  entityType: string,
  wikiId?: string,
): string {
  const today = new Date().toISOString().split('T')[0];
  const sections = ENTITY_SECTIONS[entityType] || ENTITY_SECTIONS.default;

  const frontmatter = [
    '---',
    wikiId ? `wikiId: ${wikiId}` : null,
    `title: "${topic.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    `description: ""`,
    'sidebar:',
    '  order: 50',
    `lastEdited: ${today}`,
    `createdAt: ${today}`,
    `summary: ""`,
    '---',
  ].filter(Boolean).join('\n');

  const imports = "import {EntityLink, R, KBF, Calc, DataInfoBox, DataExternalLinks} from '@components/wiki';";

  const sectionContent = sections.map(heading => {
    if (heading === 'Quick Assessment') {
      return `## ${heading}\n\n| Property | Value |\n|----------|-------|\n| **Type** | ${entityType} |\n| **Status** | {needs research} |`;
    }
    if (heading === 'Key Links') {
      return `## ${heading}\n\n| Source | Link |\n|--------|------|\n| Wikipedia | {needs research} |`;
    }
    return `## ${heading}\n\n{This section needs to be written with researched content and citations.}`;
  }).join('\n\n');

  return `${frontmatter}\n${imports}\n\n${sectionContent}\n\n## Sources\n\n{Sources will be added as footnote definitions here.}\n`;
}
