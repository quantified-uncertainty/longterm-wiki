/**
 * Validation Rules Catalog
 *
 * Single source of truth for the rule registry. Every rule the validation
 * engine knows about is re-exported here — and only rules. Non-rule helpers,
 * types, and utilities must NOT be exported from this file, because
 * `crux/lib/rules/index.ts` derives `allRules` from `Object.values()` of this
 * module and assumes every exported value is a `Rule`.
 *
 * To add a new rule: add one `export { xRule } from './x.ts';` line below.
 * Do not edit `index.ts` — it auto-derives the array.
 */

// Content validation rules
export { entityLinkIdsRule } from './entitylink-ids.ts';
export { dollarSignsRule } from './dollar-signs.ts';
export { tildeDollarRule } from './tilde-dollar.ts';
export { comparisonOperatorsRule } from './comparison-operators.ts';
export { estimateBoxesRule } from './estimate-boxes.ts';
export { placeholdersRule } from './placeholders.ts';
export { fakeUrlsRule } from './fake-urls.ts';
export { internalLinksRule } from './internal-links.ts';
export { componentRefsRule } from './component-refs.ts';
export { preferEntityLinkRule } from './prefer-entitylink.ts';

// Sidebar/structure rules
export { kbSubcategoryCoverageRule } from './factbase-subcategory-coverage.ts';

// File-level rules
export { jsxInMdRule } from './jsx-in-md.ts';

// Markdown formatting rules
export { markdownListsRule } from './markdown-lists.ts';
export { consecutiveBoldLabelsRule } from './consecutive-bold-labels.ts';

// Component validation rules
export { componentImportsRule } from './component-imports.ts';
export { citationUrlsRule } from './citation-urls.ts';
export { vagueCitationsRule } from './vague-citations.ts';
export { datainfoboxEntityMatchRule } from './datainfobox-entity-match.ts';

// External link validation
export { externalLinksRule } from './external-links.ts';

// Schema validation rules
export { frontmatterSchemaRule } from './frontmatter-schema.ts';
export { wikiIdIntegrityRule } from './wiki-id-integrity.ts';
export { noQuotedSubcategoryRule } from './no-quoted-subcategory.ts';

// Quality validation rules
export { temporalArtifactsRule } from './temporal-artifacts.ts';
export { editorialArtifactsRule } from './editorial-artifacts.ts';
export { outdatedNamesRule } from './outdated-names.ts';

export { hardcodedCalculationsRule } from './hardcoded-calculations.ts';

// Content quality warning rules (used by grading pipeline)
export { insiderJargonRule } from './insider-jargon.ts';
export { falseCertaintyRule } from './false-certainty.ts';
export { prescriptiveLanguageRule } from './prescriptive-language.ts';
export { toneMarkersRule } from './tone-markers.ts';
export { structuralQualityRule } from './structural-quality.ts';
export { evaluativeFramingRule } from './evaluative-framing.ts';

// Biographical accuracy (person/org pages)
export { unsourcedBiographicalClaimsRule } from './unsourced-biographical-claims.ts';
export { evaluativeFlattery } from './evaluative-flattery.ts';

// Citation coverage
export { footnoteCoverageRule } from './footnote-coverage.ts';
export { noUrlFootnotesRule } from './no-url-footnotes.ts';

// Citation quality
export { footnoteQualityRule } from './footnote-quality.ts';

// Hallucination risk reduction (issue #200)
export { citationDensityRule } from './citation-density.ts';
export { balanceFlagsRule } from './balance-flags.ts';

// Table header consistency (issue #379)
export { tableHeadersRule } from './table-headers.ts';

// Frontmatter field order (issue #398)
export { frontmatterOrderRule } from './frontmatter-order.ts';

// Security / safety checks
export { urlSafetyRule } from './url-safety.ts';
export { noExecSyncRule } from './no-exec-sync.ts';

// Data integrity checks
export { resourceRefIntegrityRule } from './resource-ref-integrity.ts';
export { kbfRefsRule } from './factbase-refs.ts';

// Deprecated component detection
export { noDeprecatedComponentsRule } from './no-deprecated-components.ts';

// Pipeline artifact detection
export { pipelineArtifactsRule } from './pipeline-artifacts.ts';

// Footnote integrity (orphans, leaked SRC markers)
export { footnoteIntegrityRule } from './footnote-integrity.ts';

// Orphaned footnote definitions (auto-removable)
export { orphanedFootnotesRule } from './orphaned-footnotes.ts';

// Numbered footnotes migration (issue #1162)
export { numberedFootnotesRule } from './numbered-footnotes.ts';

// Content quality rules (issues #916, #922)
export { placeholderTextRule } from './placeholder-text.ts';
export { personOrgAffiliationRule } from './person-org-affiliation.ts';

// Style guide compliance
export { styleGuideRule } from './style-guide.ts';

// Broken internal links
export { brokenLinksRule } from './broken-links.ts';

// Cross-page consistency rules (ported from validate-consistency.ts)
export { probabilityConsistencyRule } from './probability-consistency.ts';
export { terminologyVariantsRule } from './terminology-variants.ts';
