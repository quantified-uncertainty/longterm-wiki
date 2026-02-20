/**
 * Validation Rules Index
 *
 * Central export for all validation rules.
 * Add new rules here to make them available to the validation engine.
 */

import type { Rule } from '../validation-engine.ts';

// Content validation rules
import { entityLinkIdsRule } from './entitylink-ids.ts';
import { dollarSignsRule } from './dollar-signs.ts';
import { tildeDollarRule } from './tilde-dollar.ts';
import { comparisonOperatorsRule } from './comparison-operators.ts';
import { estimateBoxesRule } from './estimate-boxes.ts';
import { placeholdersRule } from './placeholders.ts';
import { fakeUrlsRule } from './fake-urls.ts';
import { internalLinksRule } from './internal-links.ts';
import { componentRefsRule } from './component-refs.ts';
import { preferEntityLinkRule } from './prefer-entitylink.ts';

// Sidebar/structure rules
import { sidebarIndexRule } from './sidebar-index.ts';
import { kbSubcategoryCoverageRule } from './kb-subcategory-coverage.ts';

// File-level rules
import { jsxInMdRule } from './jsx-in-md.ts';
import { cruftFilesRule } from './cruft-files.ts';

// Markdown formatting rules
import { markdownListsRule } from './markdown-lists.ts';
import { consecutiveBoldLabelsRule } from './consecutive-bold-labels.ts';

// Component validation rules
import { componentPropsRule } from './component-props.ts';
import { componentImportsRule } from './component-imports.ts';
import { citationUrlsRule } from './citation-urls.ts';
import { vagueCitationsRule } from './vague-citations.ts';

// External link validation
import { externalLinksRule } from './external-links.ts';

// Schema validation rules
import { frontmatterSchemaRule } from './frontmatter-schema.ts';
import { numericIdIntegrityRule } from './numeric-id-integrity.ts';
import { noQuotedSubcategoryRule } from './no-quoted-subcategory.ts';

// Quality validation rules
import { temporalArtifactsRule } from './temporal-artifacts.ts';
import { editorialArtifactsRule } from './editorial-artifacts.ts';
import { outdatedNamesRule } from './outdated-names.ts';

// Fact consistency
import { factConsistencyRule } from './fact-consistency.ts';
import { hardcodedCalculationsRule } from './hardcoded-calculations.ts';

// Squiggle model quality
import { squiggleQualityRule } from './squiggle-quality.ts';

// Content quality warning rules (used by grading pipeline)
import { insiderJargonRule } from './insider-jargon.ts';
import { falseCertaintyRule } from './false-certainty.ts';
import { prescriptiveLanguageRule } from './prescriptive-language.ts';
import { toneMarkersRule } from './tone-markers.ts';
import { structuralQualityRule } from './structural-quality.ts';
import { evaluativeFramingRule } from './evaluative-framing.ts';

// Biographical accuracy (person/org pages)
import { unsourcedBiographicalClaimsRule } from './unsourced-biographical-claims.ts';
import { evaluativeFlattery } from './evaluative-flattery.ts';

// Citation coverage
import { footnoteCoverageRule } from './footnote-coverage.ts';
import { noUrlFootnotesRule } from './no-url-footnotes.ts';

// Citation accuracy
import { citationDoiMismatchRule } from './citation-doi-mismatch.ts';

// Hallucination risk reduction (issue #200)
import { citationDensityRule } from './citation-density.ts';
import { balanceFlagsRule } from './balance-flags.ts';

// Table header consistency (issue #379)
import { tableHeadersRule } from './table-headers.ts';

// Frontmatter field order (issue #398)
import { frontmatterOrderRule } from './frontmatter-order.ts';

// Security / safety checks
import { urlSafetyRule } from './url-safety.ts';
import { noExecSyncRule } from './no-exec-sync.ts';

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
  sidebarIndexRule,
  kbSubcategoryCoverageRule,
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
  numericIdIntegrityRule,
  noQuotedSubcategoryRule,
  temporalArtifactsRule,
  editorialArtifactsRule,
  outdatedNamesRule,
  factConsistencyRule,
  hardcodedCalculationsRule,
  insiderJargonRule,
  falseCertaintyRule,
  prescriptiveLanguageRule,
  toneMarkersRule,
  structuralQualityRule,
  evaluativeFramingRule,
  squiggleQualityRule,
  unsourcedBiographicalClaimsRule,
  evaluativeFlattery,
  footnoteCoverageRule,
  noUrlFootnotesRule,
  citationDoiMismatchRule,
  citationDensityRule,
  balanceFlagsRule,
  tableHeadersRule,
  frontmatterOrderRule,
  urlSafetyRule,
  noExecSyncRule,
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
  sidebarIndexRule,
  kbSubcategoryCoverageRule,
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
  numericIdIntegrityRule,
  noQuotedSubcategoryRule,
  temporalArtifactsRule,
  editorialArtifactsRule,
  outdatedNamesRule,
  factConsistencyRule,
  hardcodedCalculationsRule,
  insiderJargonRule,
  falseCertaintyRule,
  prescriptiveLanguageRule,
  toneMarkersRule,
  structuralQualityRule,
  evaluativeFramingRule,
  squiggleQualityRule,
  unsourcedBiographicalClaimsRule,
  evaluativeFlattery,
  footnoteCoverageRule,
  noUrlFootnotesRule,
  citationDoiMismatchRule,
  citationDensityRule,
  balanceFlagsRule,
  tableHeadersRule,
  frontmatterOrderRule,
  urlSafetyRule,
  noExecSyncRule,
];

export default allRules;
