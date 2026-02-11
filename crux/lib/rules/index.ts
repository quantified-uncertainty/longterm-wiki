/**
 * Validation Rules Index
 *
 * Central export for all validation rules.
 * Add new rules here to make them available to the validation engine.
 */

import type { Rule } from '../validation-engine.ts';

// Content validation rules
import { entityLinkIdsRule } from './entitylink-ids.js';
import { dollarSignsRule } from './dollar-signs.js';
import { tildeDollarRule } from './tilde-dollar.js';
import { comparisonOperatorsRule } from './comparison-operators.js';
import { estimateBoxesRule } from './estimate-boxes.js';
import { placeholdersRule } from './placeholders.js';
import { fakeUrlsRule } from './fake-urls.js';
import { internalLinksRule } from './internal-links.js';
import { componentRefsRule } from './component-refs.js';
import { preferEntityLinkRule } from './prefer-entitylink.js';
import { entityMentionsRule } from './entity-mentions.js';

// Sidebar/structure rules
import { sidebarCoverageRule } from './sidebar-coverage.js';
import { sidebarIndexRule } from './sidebar-index.js';

// File-level rules
import { jsxInMdRule } from './jsx-in-md.js';
import { cruftFilesRule } from './cruft-files.js';

// Markdown formatting rules
import { markdownListsRule } from './markdown-lists.js';
import { consecutiveBoldLabelsRule } from './consecutive-bold-labels.js';

// Component validation rules
import { componentPropsRule } from './component-props.js';
import { componentImportsRule } from './component-imports.js';
import { citationUrlsRule } from './citation-urls.js';
import { vagueCitationsRule } from './vague-citations.js';

// External link validation
import { externalLinksRule } from './external-links.js';

// Schema validation rules
import { frontmatterSchemaRule } from './frontmatter-schema.js';

// Quality validation rules
import { qualitySourceRule } from './quality-source.js';
import { temporalArtifactsRule } from './temporal-artifacts.js';
import { editorialArtifactsRule } from './editorial-artifacts.js';
import { outdatedNamesRule } from './outdated-names.js';

// Fact consistency
import { factConsistencyRule } from './fact-consistency.js';

// Squiggle model quality
import { squiggleQualityRule } from './squiggle-quality.js';

// Content quality warning rules (3-step grading pipeline)
import { insiderJargonRule } from './insider-jargon.js';
import { falseCertaintyRule } from './false-certainty.js';
import { prescriptiveLanguageRule } from './prescriptive-language.js';
import { toneMarkersRule } from './tone-markers.js';
import { structuralQualityRule } from './structural-quality.js';

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
  squiggleQualityRule,
};

export const allRules: Rule[] = [
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
  squiggleQualityRule,
];

export default allRules;
