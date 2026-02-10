/**
 * Validation Rules Index
 *
 * Central export for all validation rules.
 * Add new rules here to make them available to the validation engine.
 */

// Content validation rules
import { entityLinkIdsRule } from './entitylink-ids.mjs';
import { dollarSignsRule } from './dollar-signs.mjs';
import { tildeDollarRule } from './tilde-dollar.mjs';
import { comparisonOperatorsRule } from './comparison-operators.mjs';
import { estimateBoxesRule } from './estimate-boxes.mjs';
import { placeholdersRule } from './placeholders.mjs';
import { fakeUrlsRule } from './fake-urls.mjs';
import { internalLinksRule } from './internal-links.mjs';
import { componentRefsRule } from './component-refs.mjs';
import { preferEntityLinkRule } from './prefer-entitylink.mjs';
import { entityMentionsRule } from './entity-mentions.mjs';

// Sidebar/structure rules
import { sidebarCoverageRule } from './sidebar-coverage.mjs';
import { sidebarIndexRule } from './sidebar-index.mjs';

// File-level rules
import { jsxInMdRule } from './jsx-in-md.mjs';
import { cruftFilesRule } from './cruft-files.mjs';

// Markdown formatting rules
import { markdownListsRule } from './markdown-lists.mjs';
import { consecutiveBoldLabelsRule } from './consecutive-bold-labels.mjs';

// Component validation rules
import { componentPropsRule } from './component-props.mjs';
import { componentImportsRule } from './component-imports.mjs';
import { citationUrlsRule } from './citation-urls.mjs';
import { vagueCitationsRule } from './vague-citations.mjs';

// External link validation
import { externalLinksRule } from './external-links.mjs';

// Schema validation rules
import { frontmatterSchemaRule } from './frontmatter-schema.mjs';

// Quality validation rules
import { qualitySourceRule } from './quality-source.mjs';
import { temporalArtifactsRule } from './temporal-artifacts.mjs';
import { editorialArtifactsRule } from './editorial-artifacts.mjs';
import { outdatedNamesRule } from './outdated-names.mjs';

// Fact consistency
import { factConsistencyRule } from './fact-consistency.mjs';

// Content quality warning rules (3-step grading pipeline)
import { insiderJargonRule } from './insider-jargon.mjs';
import { falseCertaintyRule } from './false-certainty.mjs';
import { prescriptiveLanguageRule } from './prescriptive-language.mjs';
import { toneMarkersRule } from './tone-markers.mjs';
import { structuralQualityRule } from './structural-quality.mjs';

// Re-export all rules individually
export {
  entityLinkIdsRule,
  dollarSignsRule,
  tildeDollarRule,
  comparisonOperatorsRule,
  estimateBoxesRule,
  placeholdersRule,
  fakeUrlsRule,
  internalLinksRule,
  componentRefsRule,
  preferEntityLinkRule,
  entityMentionsRule,
  sidebarCoverageRule,
  sidebarIndexRule,
  jsxInMdRule,
  cruftFilesRule,
  markdownListsRule,
  consecutiveBoldLabelsRule,
  componentPropsRule,
  componentImportsRule,
  citationUrlsRule,
  vagueCitationsRule,
  externalLinksRule,
  frontmatterSchemaRule,
  qualitySourceRule,
  temporalArtifactsRule,
  editorialArtifactsRule,
  outdatedNamesRule,
  factConsistencyRule,
  insiderJargonRule,
  falseCertaintyRule,
  prescriptiveLanguageRule,
  toneMarkersRule,
  structuralQualityRule,
};

export const allRules = [
  entityLinkIdsRule,
  dollarSignsRule,
  tildeDollarRule,
  comparisonOperatorsRule,
  estimateBoxesRule,
  placeholdersRule,
  fakeUrlsRule,
  internalLinksRule,
  componentRefsRule,
  preferEntityLinkRule,
  entityMentionsRule,
  sidebarCoverageRule,
  sidebarIndexRule,
  jsxInMdRule,
  cruftFilesRule,
  markdownListsRule,
  consecutiveBoldLabelsRule,
  componentPropsRule,
  componentImportsRule,
  citationUrlsRule,
  vagueCitationsRule,
  externalLinksRule,
  frontmatterSchemaRule,
  qualitySourceRule,
  temporalArtifactsRule,
  editorialArtifactsRule,
  outdatedNamesRule,
  factConsistencyRule,
  insiderJargonRule,
  falseCertaintyRule,
  prescriptiveLanguageRule,
  toneMarkersRule,
  structuralQualityRule,
];

export default allRules;
