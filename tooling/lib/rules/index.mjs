/**
 * Validation Rules Index
 *
 * Central export for all validation rules.
 * Add new rules here to make them available to the validation engine.
 */

// Content validation rules
export { entityLinkIdsRule } from './entitylink-ids.mjs';
export { dollarSignsRule } from './dollar-signs.mjs';
export { tildeDollarRule } from './tilde-dollar.mjs';
export { comparisonOperatorsRule } from './comparison-operators.mjs';
export { estimateBoxesRule } from './estimate-boxes.mjs';
export { placeholdersRule } from './placeholders.mjs';
export { fakeUrlsRule } from './fake-urls.mjs';
export { internalLinksRule } from './internal-links.mjs';
export { componentRefsRule } from './component-refs.mjs';
export { preferEntityLinkRule } from './prefer-entitylink.mjs';
export { entityMentionsRule } from './entity-mentions.mjs';

// Sidebar/structure rules
export { sidebarCoverageRule } from './sidebar-coverage.mjs';
export { sidebarIndexRule } from './sidebar-index.mjs';

// File-level rules
export { jsxInMdRule } from './jsx-in-md.mjs';
export { cruftFilesRule } from './cruft-files.mjs';

// Markdown formatting rules
export { markdownListsRule } from './markdown-lists.mjs';
export { consecutiveBoldLabelsRule } from './consecutive-bold-labels.mjs';

// Component validation rules
export { componentPropsRule } from './component-props.mjs';
export { componentImportsRule } from './component-imports.mjs';
export { citationUrlsRule } from './citation-urls.mjs';
export { vagueCitationsRule } from './vague-citations.mjs';

// External link validation
export { externalLinksRule } from './external-links.mjs';

// Schema validation rules
export { frontmatterSchemaRule } from './frontmatter-schema.mjs';

// Quality validation rules
export { qualitySourceRule } from './quality-source.mjs';
export { temporalArtifactsRule } from './temporal-artifacts.mjs';
export { editorialArtifactsRule } from './editorial-artifacts.mjs';
export { outdatedNamesRule } from './outdated-names.mjs';

// Fact consistency
export { factConsistencyRule } from './fact-consistency.mjs';

// Content quality warning rules (3-step grading pipeline)
export { insiderJargonRule } from './insider-jargon.mjs';
export { falseCertaintyRule } from './false-certainty.mjs';
export { prescriptiveLanguageRule } from './prescriptive-language.mjs';
export { toneMarkersRule } from './tone-markers.mjs';
export { structuralQualityRule } from './structural-quality.mjs';

// Collect all rules for easy registration
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
import { sidebarCoverageRule } from './sidebar-coverage.mjs';
import { sidebarIndexRule } from './sidebar-index.mjs';
import { jsxInMdRule } from './jsx-in-md.mjs';
import { cruftFilesRule } from './cruft-files.mjs';
import { markdownListsRule } from './markdown-lists.mjs';
import { consecutiveBoldLabelsRule } from './consecutive-bold-labels.mjs';
import { componentPropsRule } from './component-props.mjs';
import { componentImportsRule } from './component-imports.mjs';
import { citationUrlsRule } from './citation-urls.mjs';
import { vagueCitationsRule } from './vague-citations.mjs';
import { externalLinksRule } from './external-links.mjs';
import { frontmatterSchemaRule } from './frontmatter-schema.mjs';
import { qualitySourceRule } from './quality-source.mjs';
import { temporalArtifactsRule } from './temporal-artifacts.mjs';
import { editorialArtifactsRule } from './editorial-artifacts.mjs';
import { outdatedNamesRule } from './outdated-names.mjs';
import { factConsistencyRule } from './fact-consistency.mjs';
import { insiderJargonRule } from './insider-jargon.mjs';
import { falseCertaintyRule } from './false-certainty.mjs';
import { prescriptiveLanguageRule } from './prescriptive-language.mjs';
import { toneMarkersRule } from './tone-markers.mjs';
import { structuralQualityRule } from './structural-quality.mjs';

export const allRules = [
  // Content validation
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

  // Sidebar/structure
  sidebarCoverageRule,
  sidebarIndexRule,

  // File-level
  jsxInMdRule,
  cruftFilesRule,

  // Markdown formatting
  markdownListsRule,
  consecutiveBoldLabelsRule,

  // Component validation
  componentPropsRule,
  componentImportsRule,
  citationUrlsRule,
  vagueCitationsRule,

  // External link validation
  externalLinksRule,

  // Schema validation
  frontmatterSchemaRule,

  // Quality validation
  qualitySourceRule,
  temporalArtifactsRule,
  editorialArtifactsRule,
  outdatedNamesRule,

  // Fact consistency
  factConsistencyRule,

  // Content quality warnings (3-step grading pipeline)
  insiderJargonRule,
  falseCertaintyRule,
  prescriptiveLanguageRule,
  toneMarkersRule,
  structuralQualityRule,
];

export default allRules;
