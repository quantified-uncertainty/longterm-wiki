# Model Reviews and Practice Trackers

**Status**: Brainstorm / design note — not yet ticketed.
**Author**: Codex (this session, 2026-05-03).
**Reviewers**: TBD.
**Related areas**: `/scorecards`, AI model pages, organization pages, frontier safety frameworks, sourcing.

## 1. Where this note should live

This brainstorming could be stored in several places:

| Option | Fit | Pros | Cons | Verdict |
|---|---|---|---|---|
| Local plan doc in `docs/plans/` | Strong | Durable, reviewable in git, sits next to the scorecard architecture note, good for exploratory taxonomy | Not visible in product UI until implemented | **Use now** |
| Linear issue | Medium | Good once scope is implementation-ready; can assign, schedule, and split into subtasks | Too much structure for early taxonomy; risks prematurely committing to a schema/page name | Use after review |
| Internal wiki page | Medium | Better for stakeholder-facing product strategy if this should be browseable by non-engineers | Less tied to code/schema decisions; may drift from implementation | Good follow-up once direction is accepted |
| Repo `todo/` | Weak | Simple | Existing `todo/` is migration cleanup, not product design | Avoid |
| ADR | Weak for now | Good for irreversible architecture decisions | This is not yet a decision; it is a taxonomy and product-surface proposal | Avoid until schema choice is settled |

Recommendation: keep this as a local design note now; file Linear tickets only after deciding which slice to build first.

## 2. Problem

The current `/scorecards` surface captures company-level external grades from a small set of AI-safety scorecards. It does not yet cover adjacent but distinct data:

- model-specific third-party reviews and evaluations;
- which outside organizations reviewed which models;
- links to public outcomes from those reviews;
- whether review happened pre-deployment or post-deployment;
- Responsible Scaling Policies / frontier safety policies and their model applicability;
- safety cases or safety-case-like artifacts;
- industry-wide practice adoption trackers that are not scorecards.

These should not all be forced into the scorecard matrix. They have different units of analysis and different evidence shapes.

## 3. Proposed taxonomy

### 3.1 Scorecards

External evaluators grading firms or models.

Current examples:

- Future of Life Institute AI Safety Index
- SaferAI Ratings
- Foundation Model Transparency Index
- AI Lab Watch
- Seoul Commitment Tracker, though it may fit better as a practice tracker because it measures commitment fulfillment

Core fields:

- `publisher`
- `targetEntityId`
- `targetType`: `organization | ai-model | model-family`
- `wave`
- `overallGrade`
- `dimensionScores`
- `methodologyUrl`
- `sourceUrl`
- `publishedAt`
- `isLatest`

Implementation note: the existing scorecard schema already stores a generic `entity_id`, so model-specific scorecard rows are possible. The web UI still assumes organization rows in copy and links, so it should be generalized before ingesting model-level rows.

### 3.2 Third-party model reviews

Specific external reviews/evaluations of a model or model family, with an outcome link when public.

Examples:

- METR model evaluations, including partnership and no-company-involvement reports: <https://evals.alignment.org/>
- Apollo Research scheming/deception evaluations: <https://www.apolloresearch.ai/research/scheming-reasoning-evaluations>
- US/UK AISI pre-deployment evaluation of OpenAI o1: <https://www.nist.gov/news-events/news/2024/12/pre-deployment-evaluation-openais-o1-model>
- System cards that cite external eval partners, such as OpenAI o1: <https://openai.com/index/openai-o1-system-card/>

Suggested fields:

- `modelId`
- `developerId`
- `reviewerOrgId`
- `reviewType`: `autonomy | scheming | cyber | bio | cbrn | persuasion | red-team | safety-case-review | benchmark | general-safety`
- `riskDomains`
- `accessTiming`: `pre-deployment | launch-time | post-deployment | independent-public`
- `accessMode`: `api | internal-checkpoint | hosted-environment | public-release | unknown`
- `companyInvolvement`: `partnership | independent | government-access | unknown`
- `outcomeUrl`
- `outcomeSummary`
- `publishedAt`
- `confidentiality`: `public | partial-public-summary | private | no-public-outcome`
- `sourceUrl`

Product surfaces:

- Model page: “Third-party reviews” table.
- Company page: aggregate reviews across that company’s models.
- Practice-tracker page: cross-company coverage matrix for external review practices.

### 3.3 Pre-deployment access agreements

Agreements or commitments that external evaluators get access before launch. These are distinct from completed public evaluations.

Examples:

- US AISI MOUs with Anthropic and OpenAI for access before and after public release: <https://www.nist.gov/news-events/news/2024/08/us-ai-safety-institute-signs-agreements-regarding-ai-safety-research>
- UK/US AISI joint access/testing announcements and reports when available.

Suggested fields:

- `reviewerOrgId`
- `developerId`
- `agreementDate`
- `coveredModels`: explicit models when known, otherwise `unknown/future-major-models`
- `accessTimingCommitment`
- `accessScope`
- `publicOutcomeRequired`: boolean / unknown
- `outcomeUrl`
- `sourceUrl`

### 3.4 Safety frameworks / RSPs

Company-level safety policies, often with thresholds or covered model classes.

Examples:

- Anthropic Responsible Scaling Policy
- OpenAI Preparedness Framework
- Google DeepMind Frontier Safety Framework
- METR Common Elements of Frontier AI Safety Policies: <https://metr.org/common-elements>

Suggested fields:

- `developerId`
- `frameworkName`
- `version`
- `publishedAt`
- `coveredModels` / `coveredModelFamilies`
- `capabilityThresholds`
- `riskDomains`
- `evalTiming`
- `deploymentMitigations`
- `haltConditions`
- `thirdPartyReviewCommitments`
- `sourceUrl`

Relationship to current app: `/frontier-safety-frameworks` already covers much of this. The missing connection is model-level applicability and cross-linking from model pages.

### 3.5 Safety cases

System-specific arguments and evidence that a particular model/deployment is safe enough under stated assumptions.

Example background:

- UK AISI safety case discussion: <https://www.aisi.gov.uk/blog/how-can-safety-cases-be-used-to-help-with-frontier-ai-safety>

Suggested fields:

- `modelId`
- `developerId`
- `safetyCaseName`
- `publishedAt`
- `publicUrl`
- `riskClaims`
- `evidenceArtifacts`
- `reviewerOrgIds`
- `confidence / limitations`
- `sourceUrl`

This should probably start as artifact/resource metadata, not a bespoke scoring system.

### 3.6 Practice adoption trackers

Industry-wide tracking of whether developers have adopted particular practices. This is the conceptual sibling to `/scorecards`, but not the same page.

Candidate URL:

- `/practice-trackers`

Why not `/adoption-trackers`: “adoption” can read as enterprise/product adoption. “Practice trackers” better captures governance and safety practices.

Candidate sources:

- Partnership on AI 2026 Transparency Report on Foundation Model Impacts: <https://partnershiponai.org/resource/2026-transparency-report-on-foundation-model-impacts/>
- METR Common Elements of Frontier AI Safety Policies
- Carnegie / IAPS comparative RSP analyses
- Apollo Research behavioral-eval coverage
- EU General-Purpose AI Code of Practice signatory tracking: <https://digital-strategy.ec.europa.eu/en/policies/contents-code-gpai>
- AISI pre-deployment access trackers, if sourceable

Suggested fields:

- `trackerId`
- `trackerName`
- `publisherId`
- `trackerType`: `practice-adoption | policy-comparison | signatory-tracking | external-eval-coverage | commitment-fulfillment`
- `targetType`: `organization | ai-model | model-family | policy | commitment`
- `practices`
- `coverageRows`
- `methodologyUrl`
- `sourceUrl`
- `publishedAt`
- `latest`

## 4. Recommended product split

1. Keep `/scorecards` focused on external grades.
2. Add `/practice-trackers` for industry-wide practice adoption and commitment tracking.
3. Add a model-page “Third-party reviews” table.
4. Add a company-page aggregate “Model reviews” or “External reviews” section.
5. Cross-link safety frameworks/RSPs to the models or model families they govern.

The first useful implementation slice is likely the model-page third-party reviews table, because it creates a clear home for “who reviewed this model, when, and what did they find?”

## 5. Open questions

- Should Seoul Commitment Tracker remain in `/scorecards`, move to `/practice-trackers`, or appear in both with different framing?
- Should third-party model reviews live in a new table, FactBase facts, or a generic artifact/relation table?
- How should private/no-public-outcome reviews be represented without implying more than the source supports?
- How should model-family reviews be handled when the public report covers “Claude 3.7” or “GPT-5” broadly rather than one exact API model ID?
- Do AISI access agreements belong as “reviews,” “practice adoption,” or their own agreement/commitment record type?
- Should public system cards that cite external reviewers be treated as outcome URLs even when the reviewer did not publish an independent report?

## 6. Source leads

- METR evaluations: <https://evals.alignment.org/>
- METR Common Elements: <https://metr.org/common-elements>
- Apollo Research scheming evaluations: <https://www.apolloresearch.ai/research/scheming-reasoning-evaluations>
- NIST AISI agreements: <https://www.nist.gov/news-events/news/2024/08/us-ai-safety-institute-signs-agreements-regarding-ai-safety-research>
- NIST o1 pre-deployment evaluation: <https://www.nist.gov/news-events/news/2024/12/pre-deployment-evaluation-openais-o1-model>
- OpenAI o1 system card: <https://openai.com/index/openai-o1-system-card/>
- PAI 2026 Transparency Report: <https://partnershiponai.org/resource/2026-transparency-report-on-foundation-model-impacts/>
- EU GPAI Code of Practice: <https://digital-strategy.ec.europa.eu/en/policies/contents-code-gpai>
- FLI AI Safety Index: <https://futureoflife.org/ai-safety-index-summer-2025/>
- Stanford FMTI reports: <https://crfm.stanford.edu/fmti/>
- UK AISI safety cases: <https://www.aisi.gov.uk/blog/how-can-safety-cases-be-used-to-help-with-frontier-ai-safety>
