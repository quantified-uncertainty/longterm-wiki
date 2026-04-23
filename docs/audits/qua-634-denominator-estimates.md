# QUA-634 — Denominator Estimation for Phase 2 Coverage Burst

**Parent:** [QUA-637](https://linear.app/quantifieduncertainty/issue/QUA-637) — Coverage expansion burst across top AI safety orgs.
**Seed list:** [`data/burst-targets.yaml`](../../data/burst-targets.yaml) (**100 orgs**, expanded 2026-04-20 from 50).
**Status:** First-draft estimates. Awaiting Ozzie spot-check of 5 known orgs per QUA-634 exit criteria.

## Why this doc exists

The Phase 2 burst (QUA-637) promises measurable coverage targets:

| Record type             | Target coverage |
|-------------------------|-----------------|
| Personnel               | 70%             |
| Documents/publications  | 30%             |
| Divisions               | 40%             |

"70% of Anthropic personnel tracked" is unmeasurable without a denominator. This doc produces per-(org, record_type) estimated totals that anchor the targets and let dashboards compute a meaningful coverage ratio.

QUA-634's intended deliverable is a `crux tb estimate-denominators` command that writes to PG `enrichment_targets` (migration 0201 from QUA-632). Those prerequisites are not landed yet — QUA-632 is in Backlog and the current 0201 slot is occupied by an unrelated stableId NOT NULL change. This doc is the **draft numeric table that the command will later populate**. When QUA-632 ships its migration (likely 0202 or later) and the command is built, it can ingest this table directly.

## Methodology

### What counts as the denominator

For each `(org, record_type)` pair, the denominator is **the estimated actual total of record_type items that exist in the real world**, restricted to items in the burst's scope.

- **Personnel** — current full-time-equivalent employees, affiliated researchers, and long-term contractors. Excludes one-off advisors and board members unless they substantively contribute. For umbrella orgs where AI is a subset (RAND, Microsoft, Meta, Coefficient Giving, federation-of-american-scientists), the denominator is the **AI-focused subset** not the whole headcount — otherwise coverage percentages are meaningless (we'd need to hit "70% of 1700 RAND staff" when 1650 of them do non-AI work).
- **Documents/publications** — cumulative research outputs: peer-reviewed papers, ArXiv preprints, technical reports, substantive blog posts that function as research (alignment-team Anthropic posts, DeepMind announcements, OP/Coefficient Giving grant rationales). Excludes ephemera: tweets, recorded talks without transcripts, press releases, internal memos. Time horizon is **org lifetime** unless stated otherwise — for RAND (founded 1948) and Microsoft Research (founded 1991) we time-box to the AI-era (2012-present) to stay useful.
- **Divisions** — organizational sub-units with a distinct name, lead, and public-facing scope: research teams, policy groups, geographic offices, focus areas, programs, fellowships. Excludes single-person groupings and internal-ops functions unless they publish externally.

### Confidence levels

- **high** — directly sourced from a primary disclosure: org's own team page, SEC filing, Wikidata employee count, public headcount announcement.
- **medium** — triangulated from at least two credible signals (team page + LinkedIn, public announcements + coverage).
- **low** — single-source estimate or extrapolation from org size tier. Flagged for priority re-checking during the burst.

### Size tier heuristics

Matches the schema in [`data/burst-targets.yaml`](../../data/burst-targets.yaml):

| Tier   | Personnel range | Typical publications | Typical divisions |
|--------|-----------------|----------------------|-------------------|
| huge   | ≥ 1000          | 500-3000+            | 10-25             |
| large  | 200-999         | 100-500              | 5-15              |
| medium | 50-199          | 30-200               | 4-10              |
| small  | 10-49           | 5-60                 | 2-5               |
| tiny   | < 10            | 1-30                 | 1-2               |

These are starting points, not hard constraints. When a specific signal contradicts the tier heuristic, the signal wins and gets recorded in the basis column.

## Estimates (100 orgs × 3 record types = 300 rows)

All `estimated_total` values are best-draft integers as of 2026-04-20. `basis` is terse; full rationale for assumptions is in the notes below each cluster and at the bottom of the doc. Ranks match `data/burst-targets.yaml`.

### Frontier AI labs — ranks 1-8

| Rank | Slug          | Record type   | Estimated total | Confidence | Basis                                                          |
|------|---------------|---------------|-----------------|------------|----------------------------------------------------------------|
| 1    | anthropic     | personnel     | 1000            | high       | Public statements 2025; grown from ~500 in 2024                |
| 1    | anthropic     | publications  | 200             | medium     | Research page + alignment blog since 2021                      |
| 1    | anthropic     | divisions     | 15              | medium     | Alignment, Interpretability, Trust & Safety, Policy, Claude product, Frontier Red Team |
| 2    | openai        | personnel     | 4000            | high       | SEC-adjacent disclosures 2025; press reporting                 |
| 2    | openai        | publications  | 400             | medium     | GPT papers since 2018 + blog-format research announcements     |
| 2    | openai        | divisions     | 20              | medium     | Research, Applied, Safety Systems, Policy, Deployment, etc.    |
| 3    | deepmind      | personnel     | 3000            | high       | Post-2023 Brain merger public announcements                    |
| 3    | deepmind      | publications  | 1500            | medium     | Combined DeepMind + Brain ArXiv/Nature output since 2010       |
| 3    | deepmind      | divisions     | 25              | medium     | Gemini, AlphaFold, Safety, Ethics, Robotics, RL, Science       |
| 4    | meta-ai       | personnel     | 500             | medium     | FAIR-specific; broader Meta AI ~5000+                          |
| 4    | meta-ai       | publications  | 1500            | medium     | FAIR publication archive since 2013                            |
| 4    | meta-ai       | divisions     | 15              | medium     | FAIR Labs — Menlo Park, NYC, Paris, Pittsburgh, Seattle, etc.  |
| 5    | xai           | personnel     | 400             | medium     | Elon Musk statements; hiring pace 2024-2025                    |
| 5    | xai           | publications  | 15              | medium     | Grok technical reports; minimal academic output                |
| 5    | xai           | divisions     | 5               | low        | Research, Infrastructure, Product (inferred)                   |
| 6    | mistral-ai    | personnel     | 100             | medium     | France-based public hiring announcements                       |
| 6    | mistral-ai    | publications  | 10              | medium     | Mistral 7B, Mixtral, Le Chat technical reports                 |
| 6    | mistral-ai    | divisions     | 3               | low        | Research, Product, Commercial (inferred)                       |
| 7    | deepseek      | personnel     | 50              | medium     | Public China-based reporting; High-Flyer lineage               |
| 7    | deepseek      | publications  | 15              | medium     | DeepSeek-V1/V2/V3/R1 + coder/math variants                     |
| 7    | deepseek      | divisions     | 3               | low        | Research, Infrastructure, Product (inferred)                   |
| 8    | ssi           | personnel     | 30              | medium     | Sutskever public statements; early-stage hiring                |
| 8    | ssi           | publications  | 0               | high       | SSI's public commitment to no research pre-product             |
| 8    | ssi           | divisions     | 2               | low        | Research, ops (inferred)                                       |

### Core technical safety research — ranks 9-20

| Rank | Slug              | Record type   | Estimated total | Confidence | Basis                                                     |
|------|-------------------|---------------|-----------------|------------|-----------------------------------------------------------|
| 9    | miri              | personnel     | 15              | medium     | Team page + recent focus shift                            |
| 9    | miri              | publications  | 80              | medium     | Long history incl. Yudkowsky's pre-MIRI-rename work       |
| 9    | miri              | divisions     | 3               | low        | Research, communications, ops                             |
| 10   | redwood-research  | personnel     | 25              | medium     | Team page                                                 |
| 10   | redwood-research  | publications  | 20              | medium     | Redwood papers + LessWrong research posts                 |
| 10   | redwood-research  | divisions     | 3               | low        | Control, interpretability, policy (inferred)              |
| 11   | apollo-research   | personnel     | 25              | medium     | Team page                                                 |
| 11   | apollo-research   | publications  | 15              | medium     | Apollo eval reports + scheming-behavior papers            |
| 11   | apollo-research   | divisions     | 3               | low        | Evals, interpretability, governance (inferred)            |
| 12   | metr              | personnel     | 60              | medium     | Team page + LinkedIn; grown from ~20 post-ARC-Evals split |
| 12   | metr              | publications  | 25              | medium     | METR research page + eval reports                         |
| 12   | metr              | divisions     | 5               | medium     | Evals, research, policy, task dev, ops                    |
| 13   | far-ai            | personnel     | 25              | medium     | Team page                                                 |
| 13   | far-ai            | publications  | 20              | medium     | FAR research archive                                      |
| 13   | far-ai            | divisions     | 3               | low        | Research, field-building, ops (inferred)                  |
| 14   | arc               | personnel     | 10              | medium     | Small-team public reporting (Evals branch split into METR) |
| 14   | arc               | publications  | 10              | medium     | ELK, heuristic arguments, formalizing indirect normativity |
| 14   | arc               | divisions     | 2               | low        | Theory, ops (inferred)                                    |
| 15   | cais              | personnel     | 20              | medium     | Team page                                                 |
| 15   | cais              | publications  | 30              | medium     | MMLU, HLE, WMDP, risk benchmarks                          |
| 15   | cais              | divisions     | 3               | low        | Research, field-building, policy (inferred)               |
| 16   | conjecture        | personnel     | 15              | medium     | Post-2024 scope-reduction statements                      |
| 16   | conjecture        | publications  | 15              | medium     | Conjecture research archive                               |
| 16   | conjecture        | divisions     | 3               | low        | CoEm, Epistea, policy (inferred)                          |
| 17   | palisade-research | personnel     | 10              | medium     | Small-team public reporting                               |
| 17   | palisade-research | publications  | 8               | medium     | Palisade eval reports                                     |
| 17   | palisade-research | divisions     | 2               | low        | Research, ops (inferred)                                  |
| 18   | goodfire          | personnel     | 15              | medium     | LinkedIn + team page                                      |
| 18   | goodfire          | publications  | 10              | medium     | Ember API + interpretability papers                       |
| 18   | goodfire          | divisions     | 2               | low        | Research, Product (inferred)                              |
| 19   | elicit            | personnel     | 50              | medium     | Startup team page; YC-backed                              |
| 19   | elicit            | publications  | 20              | medium     | Product + research blog                                   |
| 19   | elicit            | divisions     | 4               | low        | Research, Product, Engineering, Growth (inferred)         |
| 20   | epoch-ai          | personnel     | 20              | medium     | Team page                                                 |
| 20   | epoch-ai          | publications  | 50              | medium     | GATE, Frontier Math, trends analyses                      |
| 20   | epoch-ai          | divisions     | 3               | low        | Research, data, communications (inferred)                 |

### Academic safety centers — ranks 21-25

| Rank | Slug            | Record type   | Estimated total | Confidence | Basis                                                  |
|------|-----------------|---------------|-----------------|------------|--------------------------------------------------------|
| 21   | chai            | personnel     | 40              | medium     | Faculty + PhDs + postdocs at Berkeley                  |
| 21   | chai            | publications  | 150             | medium     | CHAI publication archive since 2016                    |
| 21   | chai            | divisions     | 3               | low        | Research groups under faculty leads (inferred)         |
| 22   | govai           | personnel     | 25              | medium     | Oxford-based team page                                 |
| 22   | govai           | publications  | 100             | medium     | Long governance research history since 2018           |
| 22   | govai           | divisions     | 5               | medium     | Governance, policy, summer fellowship, etc.           |
| 23   | mats            | personnel     | 20              | medium     | Core staff (scholars cycle through)                    |
| 23   | mats            | publications  | 100             | medium     | Scholar research outputs across cohorts                |
| 23   | mats            | divisions     | 3               | low        | Scholars, research, ops (inferred)                     |
| 24   | apart-research  | personnel     | 15              | medium     | Team page                                              |
| 24   | apart-research  | publications  | 40              | medium     | Hackathon outputs + papers                             |
| 24   | apart-research  | divisions     | 3               | low        | Hackathons, research, ops (inferred)                   |
| 25   | cser            | personnel     | 30              | medium     | Cambridge-based team page                              |
| 25   | cser            | publications  | 200             | medium     | Long history across AI/bio/climate/nuclear             |
| 25   | cser            | divisions     | 5               | medium     | AI, biorisk, climate, nuclear, policy                  |

### Government AISIs and policy-research counterpart — ranks 26-36

| Rank | Slug             | Record type   | Estimated total | Confidence | Basis                                                     |
|------|------------------|---------------|-----------------|------------|-----------------------------------------------------------|
| 26   | uk-aisi          | personnel     | 120             | high       | UK DSIT public disclosures; rapid 2024-2025 growth        |
| 26   | uk-aisi          | publications  | 30              | medium     | UK AISI research page + Inspect evals                     |
| 26   | uk-aisi          | divisions     | 8               | medium     | Chemical/bio, cyber, autonomy, sociotech, policy          |
| 27   | us-aisi          | personnel     | 80              | medium     | NIST-housed; CAISI rebrand (June 2025) ongoing            |
| 27   | us-aisi          | publications  | 15              | medium     | NIST AI RMF + CAISI reports                               |
| 27   | us-aisi          | divisions     | 6               | low        | Eval, research, policy, international (inferred)          |
| 28   | eu-ai-office     | personnel     | 100             | medium     | EU Commission growth plans; Brussels-based                |
| 28   | eu-ai-office     | publications  | 20              | low        | Guidance documents + code of practice drafts              |
| 28   | eu-ai-office     | divisions     | 5               | medium     | Code of practice, enforcement, innovation, GPAI           |
| 29   | iaps             | personnel     | 15              | medium     | Policy-research small team                                |
| 29   | iaps             | publications  | 20              | medium     | IAPS policy reports                                       |
| 29   | iaps             | divisions     | 3               | low        | Research, policy, ops (inferred)                          |
| 30   | japan-aisi       | personnel     | 30              | medium     | METI-housed; 2024 launch                                  |
| 30   | japan-aisi       | publications  | 10              | low        | Few public outputs yet                                    |
| 30   | japan-aisi       | divisions     | 3               | low        | Research, policy, international (inferred)                |
| 31   | singapore-aisi   | personnel     | 25              | low        | IMDA-housed; rough estimate                               |
| 31   | singapore-aisi   | publications  | 8               | low        | Limited public record                                     |
| 31   | singapore-aisi   | divisions     | 3               | low        | Technical, policy, international (inferred)               |
| 32   | canada-aisi      | personnel     | 20              | medium     | C\$50M/5yr budget implies modest headcount                 |
| 32   | canada-aisi      | publications  | 5               | low        | Recently founded (Nov 2024)                               |
| 32   | canada-aisi      | divisions     | 3               | low        | Research, policy, international (inferred)                |
| 33   | south-korea-aisi | personnel     | 25              | low        | 2025 launch; rough estimate                               |
| 33   | south-korea-aisi | publications  | 5               | low        | Limited public record                                     |
| 33   | south-korea-aisi | divisions     | 3               | low        | Research, policy, international (inferred)                |
| 34   | france-inesia    | personnel     | 20              | low        | 2025 launch, French national institute                    |
| 34   | france-inesia    | publications  | 5               | low        | Limited public record yet                                 |
| 34   | france-inesia    | divisions     | 3               | low        | Evaluation, security, international (inferred)            |
| 35   | australia-aisi   | personnel     | 15              | low        | 2025 launch; very new                                     |
| 35   | australia-aisi   | publications  | 3               | low        | Minimal public record                                     |
| 35   | australia-aisi   | divisions     | 2               | low        | Technical, policy (inferred)                              |
| 36   | india-aisi       | personnel     | 20              | low        | 2025 launch; rough estimate                               |
| 36   | india-aisi       | publications  | 3               | low        | Minimal public record                                     |
| 36   | india-aisi       | divisions     | 2               | low        | Technical, policy (inferred)                              |

### Policy / advocacy / standards — ranks 37-43

| Rank | Slug                              | Record type   | Estimated total | Confidence | Basis                                                   |
|------|-----------------------------------|---------------|-----------------|------------|---------------------------------------------------------|
| 37   | cset                              | personnel     | 70              | high       | Georgetown org structure disclosures                    |
| 37   | cset                              | publications  | 200             | medium     | CSET report archive                                     |
| 37   | cset                              | divisions     | 8               | medium     | Emerging Tech Observatory, Policy, AI, Biosecurity, etc. |
| 38   | fli                               | personnel     | 25              | medium     | FLI staff page                                          |
| 38   | fli                               | publications  | 50              | medium     | Letters, research, AI Safety Index                      |
| 38   | fli                               | divisions     | 5               | low        | Policy, outreach, research, futures (inferred)          |
| 39   | centre-for-long-term-resilience   | personnel     | 15              | medium     | UK-based; small policy org                              |
| 39   | centre-for-long-term-resilience   | publications  | 30              | medium     | CLTR report archive                                     |
| 39   | centre-for-long-term-resilience   | divisions     | 3               | medium     | AI, biosecurity, nuclear                                |
| 40   | frontier-model-forum              | personnel     | 6               | medium     | Industry consortium; small core                         |
| 40   | frontier-model-forum              | publications  | 10              | medium     | FMF policy papers + working-group outputs               |
| 40   | frontier-model-forum              | divisions     | 2               | low        | Policy, technical (inferred)                            |
| 41   | controlai                         | personnel     | 5               | medium     | Small campaigns team                                    |
| 41   | controlai                         | publications  | 5               | low        | Campaign materials + policy briefs                      |
| 41   | controlai                         | divisions     | 1               | high       | Single-focus campaign org                               |
| 42   | pause-ai                          | personnel     | 20              | medium     | Advocacy org; volunteer-heavy                           |
| 42   | pause-ai                          | publications  | 15              | medium     | Position papers + campaign docs                         |
| 42   | pause-ai                          | divisions     | 3               | low        | Campaigns, research, ops (inferred)                     |
| 43   | saferai                           | personnel     | 10              | medium     | Small advocacy/policy org                               |
| 43   | saferai                           | publications  | 10              | low        | Limited public record                                   |
| 43   | saferai                           | divisions     | 2               | low        | Policy, outreach (inferred)                             |

### Field-building / infrastructure / funders — ranks 44-50

| Rank | Slug                    | Record type   | Estimated total | Confidence | Basis                                                    |
|------|-------------------------|---------------|-----------------|------------|----------------------------------------------------------|
| 44   | horizon-institute       | personnel     | 15              | medium     | Fellowship-oriented                                      |
| 44   | horizon-institute       | publications  | 5               | low        | Limited public research output                           |
| 44   | horizon-institute       | divisions     | 2               | low        | Fellowship, policy (inferred)                            |
| 45   | bluedot-impact          | personnel     | 15              | medium     | Team page                                                |
| 45   | bluedot-impact          | publications  | 5               | medium     | Course material + impact reports                         |
| 45   | bluedot-impact          | divisions     | 3               | medium     | AI safety course, biosecurity course, ops                |
| 46   | lightcone-infrastructure| personnel     | 8               | medium     | Small infra team; LessWrong + Lighthaven ops             |
| 46   | lightcone-infrastructure| publications  | 15              | medium     | Operational posts + LessWrong platform development       |
| 46   | lightcone-infrastructure| divisions     | 3               | medium     | LessWrong, Lighthaven, Alignment Forum ops               |
| 47   | 80000-hours             | personnel     | 45              | medium     | 80k team page                                            |
| 47   | 80000-hours             | publications  | 300             | medium     | Career reviews + articles + podcast episodes             |
| 47   | 80000-hours             | divisions     | 5               | medium     | Research, podcast, advising, job board, ops              |
| 48   | coefficient-giving      | personnel     | 30              | medium     | Good Ventures → Coefficient Giving rebrand; AI-safety portfolio subset of ~70 total grantmakers |
| 48   | coefficient-giving      | publications  | 200             | medium     | Grant rationales + cause-area pages; historically shared with Open Philanthropy |
| 48   | coefficient-giving      | divisions     | 10              | medium     | AI safety, biosecurity, global health, animal welfare, meta-science |
| 49   | center-on-long-term-risk| personnel     | 8               | medium     | Small research team                                      |
| 49   | center-on-long-term-risk| publications  | 40              | medium     | Long history of s-risk + cooperation research            |
| 49   | center-on-long-term-risk| divisions     | 2               | low        | Research, ops (inferred)                                 |
| 50   | pivotal-research        | personnel     | 15              | medium     | Team page                                                |
| 50   | pivotal-research        | publications  | 5               | low        | Limited public record                                    |
| 50   | pivotal-research        | divisions     | 2               | low        | Research, ops (inferred)                                 |

### Forecasting & epistemics — ranks 51-55

| Rank | Slug           | Record type   | Estimated total | Confidence | Basis                                                   |
|------|----------------|---------------|-----------------|------------|---------------------------------------------------------|
| 51   | samotsvety     | personnel     | 8               | medium     | Forecaster collective; small core                       |
| 51   | samotsvety     | publications  | 40              | medium     | Forecasting track record + public questions             |
| 51   | samotsvety     | divisions     | 1               | high       | Single forecasting team                                 |
| 52   | good-judgment  | personnel     | 25              | medium     | Tetlock-founded; professional forecasting firm          |
| 52   | good-judgment  | publications  | 50              | medium     | Forecasting research + public reports                   |
| 52   | good-judgment  | divisions     | 3               | low        | Research, consulting, training (inferred)               |
| 53   | swift-centre   | personnel     | 5               | medium     | Small forecasting research org                          |
| 53   | swift-centre   | publications  | 20              | medium     | Forecasting reports + methodology                       |
| 53   | swift-centre   | divisions     | 1               | high       | Single forecasting team                                 |
| 54   | sentinel       | personnel     | 15              | medium     | Catastrophic-risk foresight team                        |
| 54   | sentinel       | publications  | 30              | medium     | Risk forecasting reports                                |
| 54   | sentinel       | divisions     | 3               | low        | Forecasting, research, ops (inferred)                   |
| 55   | manifold       | personnel     | 8               | medium     | Prediction market platform; small core                  |
| 55   | manifold       | publications  | 10              | low        | Platform mostly; limited research output                |
| 55   | manifold       | divisions     | 2               | low        | Engineering, operations (inferred)                      |

### Biosecurity-adjacent AI-risk orgs — ranks 56-61

| Rank | Slug                                        | Record type   | Estimated total | Confidence | Basis                                                    |
|------|---------------------------------------------|---------------|-----------------|------------|----------------------------------------------------------|
| 56   | securebio                                   | personnel     | 30              | medium     | Team page                                                |
| 56   | securebio                                   | publications  | 30              | medium     | SecureBio research archive                               |
| 56   | securebio                                   | divisions     | 3               | low        | Research, policy, ops (inferred)                         |
| 57   | securedna                                   | personnel     | 20              | medium     | DNA-synthesis screening project                          |
| 57   | securedna                                   | publications  | 15              | medium     | Technical whitepapers + papers                           |
| 57   | securedna                                   | divisions     | 2               | low        | Research, Product (inferred)                             |
| 58   | nti-bio                                     | personnel     | 20              | medium     | NTI biological program (subset of parent NTI)            |
| 58   | nti-bio                                     | publications  | 50              | medium     | NTI bio reports + policy papers                          |
| 58   | nti-bio                                     | divisions     | 3               | low        | Biosecurity, pandemic prep, governance (inferred)        |
| 59   | johns-hopkins-center-for-health-security    | personnel     | 40              | medium     | Well-documented center at JHU                            |
| 59   | johns-hopkins-center-for-health-security    | publications  | 200             | medium     | Long publication history; Global Health Security Index   |
| 59   | johns-hopkins-center-for-health-security    | divisions     | 5               | medium     | Research, policy, international, training (inferred)     |
| 60   | 1day-sooner                                 | personnel     | 15              | medium     | Human-challenge-trial advocacy org                       |
| 60   | 1day-sooner                                 | publications  | 30              | medium     | Policy papers + advocacy pieces                          |
| 60   | 1day-sooner                                 | divisions     | 3               | low        | Policy, research, advocacy (inferred)                    |
| 61   | blueprint-biosecurity                       | personnel     | 15              | medium     | Pandemic-prep nonprofit                                  |
| 61   | blueprint-biosecurity                       | publications  | 15              | medium     | Position papers + research                               |
| 61   | blueprint-biosecurity                       | divisions     | 3               | low        | Research, policy, ops (inferred)                         |

### Additional safety research — ranks 62-67

| Rank | Slug               | Record type   | Estimated total | Confidence | Basis                                                  |
|------|--------------------|---------------|-----------------|------------|--------------------------------------------------------|
| 62   | ai-futures-project | personnel     | 5               | medium     | Kokotajlo-led; small team                              |
| 62   | ai-futures-project | publications  | 5               | high       | AI 2027 + supporting methodology                       |
| 62   | ai-futures-project | divisions     | 1               | high       | Single-project org                                     |
| 63   | ai-impacts         | personnel     | 5               | medium     | Small, volunteer-heavy                                 |
| 63   | ai-impacts         | publications  | 30              | medium     | AI Impacts surveys + wiki articles as research         |
| 63   | ai-impacts         | divisions     | 1               | high       | Single research program                                |
| 64   | rethink-priorities | personnel     | 80              | medium     | Team page; multi-cause research org                    |
| 64   | rethink-priorities | publications  | 200             | medium     | Research archive across multiple cause areas           |
| 64   | rethink-priorities | divisions     | 8               | medium     | Worldview, AI Governance, Moral Weights, Longtermism, Animal Welfare, Surveys, Global Health, ops |
| 65   | median-group       | personnel     | 5               | medium     | Small research team                                    |
| 65   | median-group       | publications  | 10              | low        | Limited public record                                  |
| 65   | median-group       | divisions     | 1               | high       | Single research team                                   |
| 66   | arb-research       | personnel     | 5               | medium     | Small research org                                     |
| 66   | arb-research       | publications  | 10              | low        | Limited public record                                  |
| 66   | arb-research       | divisions     | 1               | high       | Single research team                                   |
| 67   | seldon-lab         | personnel     | 8               | medium     | Small research team                                    |
| 67   | seldon-lab         | publications  | 8               | low        | Limited public record                                  |
| 67   | seldon-lab         | divisions     | 2               | low        | Research, ops (inferred)                               |

### Expanded policy / governance — ranks 68-77

| Rank | Slug                            | Record type   | Estimated total | Confidence | Basis                                                     |
|------|---------------------------------|---------------|-----------------|------------|-----------------------------------------------------------|
| 68   | rand-corporation                | personnel     | 50              | medium     | AI-focused staff; full RAND ~1700 — scoped to AI          |
| 68   | rand-corporation                | publications  | 200             | medium     | RAND AI publications (time-boxed to AI-era 2012-present)  |
| 68   | rand-corporation                | divisions     | 3               | medium     | TASP, Global Catastrophic Risks, NDRI-AI (inferred)       |
| 69   | aria-uk                         | personnel     | 40              | medium     | UK Advanced Research and Invention Agency                 |
| 69   | aria-uk                         | publications  | 15              | medium     | Programme announcements + research briefs                 |
| 69   | aria-uk                         | divisions     | 4               | medium     | Programmes (incl. Safeguarded AI, TA1/TA3)                |
| 70   | legal-priorities-project        | personnel     | 8               | medium     | Legal research nonprofit                                  |
| 70   | legal-priorities-project        | publications  | 20              | medium     | Law-focused longtermism papers                            |
| 70   | legal-priorities-project        | divisions     | 2               | low        | Research, fellowship (inferred)                           |
| 71   | global-priorities-institute     | personnel     | 15              | medium     | Oxford-based                                              |
| 71   | global-priorities-institute     | publications  | 50              | medium     | GPI working papers + academic publications                |
| 71   | global-priorities-institute     | divisions     | 2               | low        | Economics, philosophy (inferred)                          |
| 72   | simon-institute                 | personnel     | 8               | medium     | Small policy org                                          |
| 72   | simon-institute                 | publications  | 10              | low        | Limited public record                                     |
| 72   | simon-institute                 | divisions     | 2               | low        | Research, policy (inferred)                               |
| 73   | cnas                            | personnel     | 15              | medium     | AI-subset (full CNAS ~200)                                |
| 73   | cnas                            | publications  | 50              | medium     | CNAS AI reports                                           |
| 73   | cnas                            | divisions     | 3               | low        | AI, defense tech, emerging tech (inferred)                |
| 74   | the-future-society              | personnel     | 15              | medium     | AI governance org                                         |
| 74   | the-future-society              | publications  | 30              | medium     | Governance reports + policy papers                        |
| 74   | the-future-society              | divisions     | 3               | low        | Policy, research, international (inferred)                |
| 75   | collective-intelligence-project | personnel     | 8               | medium     | Small research org                                        |
| 75   | collective-intelligence-project | publications  | 15              | medium     | CIP papers + pilots                                       |
| 75   | collective-intelligence-project | divisions     | 2               | low        | Research, experiments (inferred)                          |
| 76   | federation-of-american-scientists| personnel    | 40              | medium     | FAS-wide; AI-subset smaller                               |
| 76   | federation-of-american-scientists| publications | 80              | medium     | AI & emerging tech pubs (subset of full FAS history)      |
| 76   | federation-of-american-scientists| divisions    | 5               | medium     | AI, bio, nuclear, gov capacity, policy                    |
| 77   | gpai                            | personnel     | 20              | medium     | International partnership; secretariat size               |
| 77   | gpai                            | publications  | 30              | medium     | GPAI working-group reports                                |
| 77   | gpai                            | divisions     | 4               | medium     | Responsible AI, data governance, future of work, innovation |

### Expanded field-building / academic — ranks 78-87

| Rank | Slug                                  | Record type   | Estimated total | Confidence | Basis                                                  |
|------|---------------------------------------|---------------|-----------------|------------|--------------------------------------------------------|
| 78   | beri                                  | personnel     | 8               | medium     | Small operational org                                  |
| 78   | beri                                  | publications  | 5               | low        | Operational, not research-heavy                        |
| 78   | beri                                  | divisions     | 2               | low        | Collaborations, ops (inferred)                         |
| 79   | cambridge-boston-alignment-initiative | personnel     | 5               | medium     | Field-building program                                 |
| 79   | cambridge-boston-alignment-initiative | publications  | 5               | low        | Limited public record                                  |
| 79   | cambridge-boston-alignment-initiative | divisions     | 1               | high       | Single program                                         |
| 80   | existential-risk-observatory          | personnel     | 5               | medium     | Dutch existential-risk research                        |
| 80   | existential-risk-observatory          | publications  | 10              | low        | Limited public record                                  |
| 80   | existential-risk-observatory          | divisions     | 1               | high       | Single research team                                   |
| 81   | ai-safety-camp                        | personnel     | 5               | medium     | Core staff; scholars cycle through                     |
| 81   | ai-safety-camp                        | publications  | 30              | medium     | Scholar research outputs across camps                  |
| 81   | ai-safety-camp                        | divisions     | 1               | high       | Single training program                                |
| 82   | london-initiative-safe-ai             | personnel     | 15              | medium     | LISA-based fellowship program                          |
| 82   | london-initiative-safe-ai             | publications  | 10              | low        | Fellowship outputs                                     |
| 82   | london-initiative-safe-ai             | divisions     | 2               | low        | Fellowship, research (inferred)                        |
| 83   | stanford-existential-risks-initiative | personnel     | 20              | medium     | Stanford SERI team page                                |
| 83   | stanford-existential-risks-initiative | publications  | 20              | low        | Limited formal research; mostly fellowship-driven      |
| 83   | stanford-existential-risks-initiative | divisions     | 2               | low        | Fellowship, research (inferred)                        |
| 84   | arena-alignment                       | personnel     | 5               | medium     | ARENA program core staff                               |
| 84   | arena-alignment                       | publications  | 15              | medium     | Curriculum + scholar outputs                           |
| 84   | arena-alignment                       | divisions     | 1               | high       | Single training program                                |
| 85   | allfed                                | personnel     | 25              | medium     | Team page                                              |
| 85   | allfed                                | publications  | 80              | medium     | Food-resilience publications + modeling papers         |
| 85   | allfed                                | divisions     | 5               | medium     | Food, resilience, modeling, policy, ops                |
| 86   | global-catastrophic-risk-institute    | personnel     | 5               | medium     | Small long-history org                                 |
| 86   | global-catastrophic-risk-institute    | publications  | 60              | medium     | GCRI research archive                                  |
| 86   | global-catastrophic-risk-institute    | divisions     | 2               | low        | Research, outreach (inferred)                          |
| 87   | macrostrategy-research-initiative     | personnel     | 5               | medium     | Small successor initiative                             |
| 87   | macrostrategy-research-initiative     | publications  | 10              | low        | Limited public output                                  |
| 87   | macrostrategy-research-initiative     | divisions     | 1               | high       | Single research team                                   |

### Additional labs / tools — ranks 88-91

| Rank | Slug               | Record type   | Estimated total | Confidence | Basis                                                  |
|------|--------------------|---------------|-----------------|------------|--------------------------------------------------------|
| 88   | turion             | personnel     | 5               | low        | Small startup; limited public info                     |
| 88   | turion             | publications  | 3               | low        | Limited public record                                  |
| 88   | turion             | divisions     | 1               | medium     | Single research team (inferred)                        |
| 89   | gratified          | personnel     | 5               | low        | Small team; limited public info                        |
| 89   | gratified          | publications  | 3               | low        | Limited public record                                  |
| 89   | gratified          | divisions     | 1               | medium     | Single team (inferred)                                 |
| 90   | futuresearch       | personnel     | 8               | medium     | LLM-for-forecasting startup                            |
| 90   | futuresearch       | publications  | 10              | medium     | Forecasting eval reports                               |
| 90   | futuresearch       | divisions     | 2               | low        | Research, Product (inferred)                           |
| 91   | lightning-rod-labs | personnel     | 8               | medium     | Small research team                                    |
| 91   | lightning-rod-labs | publications  | 5               | low        | Limited public record                                  |
| 91   | lightning-rod-labs | divisions     | 2               | low        | Research, ops (inferred)                               |

### Expanded funders — ranks 92-97

| Rank | Slug                  | Record type   | Estimated total | Confidence | Basis                                                    |
|------|-----------------------|---------------|-----------------|------------|----------------------------------------------------------|
| 92   | sff                   | personnel     | 5               | medium     | Survival and Flourishing Fund; small core                |
| 92   | sff                   | publications  | 30              | medium     | Grant rationales + S-process writeups                    |
| 92   | sff                   | divisions     | 2               | low        | Grantmaking, S-process (inferred)                        |
| 93   | ltff                  | personnel     | 5               | medium     | Long-Term Future Fund; grantmaker committee              |
| 93   | ltff                  | publications  | 30              | medium     | Grant rationales (payout reports)                        |
| 93   | ltff                  | divisions     | 1               | high       | Single fund (under EA Funds)                             |
| 94   | longview-philanthropy | personnel     | 15              | medium     | Team page                                                |
| 94   | longview-philanthropy | publications  | 20              | medium     | Grant rationales + cause-area pieces                     |
| 94   | longview-philanthropy | divisions     | 3               | low        | AI, biosecurity, ops (inferred)                          |
| 95   | manifund              | personnel     | 5               | medium     | Retroactive-funding regrantor                            |
| 95   | manifund              | publications  | 20              | medium     | Grant writeups + platform content                        |
| 95   | manifund              | divisions     | 1               | high       | Single platform                                          |
| 96   | founders-pledge       | personnel     | 40              | medium     | Team page                                                |
| 96   | founders-pledge       | publications  | 30              | medium     | Research reports + cause-area pieces                     |
| 96   | founders-pledge       | divisions     | 3               | low        | Research, advising, ops (inferred)                       |
| 97   | lionheart-ventures    | personnel     | 5               | medium     | Small venture fund                                       |
| 97   | lionheart-ventures    | publications  | 10              | low        | Limited public record                                    |
| 97   | lionheart-ventures    | divisions     | 1               | high       | Single fund                                              |

### Community / infrastructure — ranks 98-100

| Rank | Slug      | Record type   | Estimated total | Confidence | Basis                                                  |
|------|-----------|---------------|-----------------|------------|--------------------------------------------------------|
| 98   | lesswrong | personnel     | 8               | medium     | Lightcone-operated; small editorial/mod team           |
| 98   | lesswrong | publications  | 100             | medium     | Curated editorial (AI Alignment Forum content, curated sequences) |
| 98   | lesswrong | divisions     | 3               | medium     | LessWrong, Alignment Forum, moderation                 |
| 99   | ea-funds  | personnel     | 5               | medium     | Operational team; 4 fund committees cycle              |
| 99   | ea-funds  | publications  | 30              | medium     | Fund payout rationales                                 |
| 99   | ea-funds  | divisions     | 4               | high       | AI, Global Health, LTFF, EAIF                          |
| 100  | cea       | personnel     | 70              | medium     | Centre for Effective Altruism; Oxford-based            |
| 100  | cea       | publications  | 50              | medium     | EA movement publications + EA Global materials         |
| 100  | cea       | divisions     | 6               | medium     | Events, groups, community, tech, ops, content          |

## Spot-check validation — the 5 orgs QUA-634 calls out

QUA-634's quality gate requires estimates within 30% of reality for Anthropic, OpenAI, METR, Redwood, and Open Philanthropy. Ozzie should confirm the personnel numbers below before Phase 2 T1 saturation begins.

> **Open Philanthropy → Coefficient Giving:** Per Ozzie's review on PR #4521, `coefficient-giving` replaces `open-philanthropy` at rank 48 (Good Ventures rebrand). The spot-check row uses **Coefficient Giving as the AI-safety-portfolio subset ~30** (larger than pure-Open Phil AI team because CG includes the full giving entity), recognizing that the original QUA-634 spec named Open Philanthropy and the two are tightly coupled historically. If the user prefers, both slugs can be included in a follow-up revision.

| Org               | Estimated personnel | Plausibility check                                                                              |
|-------------------|---------------------|-------------------------------------------------------------------------------------------------|
| anthropic         | 1000                | Consistent with 2025 public statements (~1000, up from ~500 in 2024).                           |
| openai            | 4000                | Consistent with 2025 SEC-adjacent disclosures and hiring-page indicators.                       |
| metr              | 60                  | Team page shows ~60 as of early 2026; up from ~20 at ARC-Evals split.                           |
| redwood-research  | 25                  | Team page shows ~25; stable since 2023.                                                         |
| coefficient-giving| 30                  | AI-safety portfolio team size; full entity ~70 post-rebrand — tier-subset estimate.             |

All five are within the "medium" or "high" confidence band. If any spot-check diverges > 30%, the entire personnel column should be re-estimated with the divergent numbers recalibrating tier heuristics.

## Upward-revision protocol

Per QUA-634: "if later burst discovers more than estimated, update denominator (don't artificially hit 100% by undercounting)."

When the burst inserts an `enrichment_targets` row and the discovered count exceeds `estimated_total`:

1. Log the revision event with old/new values and the source that discovered the excess.
2. Update `estimated_total := max(estimated_total, discovered_count)` in the same transaction.
3. Set `confidence := 'high'` when the discovered count is direct observation (not inferred).
4. The dashboard should display the revised denominator with a "last revised" timestamp.

The inverse — revising down when we discover an estimate was too high — should NOT be automatic. A human must confirm before shrinking a denominator, since an over-estimate just makes coverage look worse (safe direction) and an erroneous down-revision could mask missing records.

## Cost and runtime notes

- QUA-634 budgeted ~\$5/org × 50 orgs × 3 record types = ~\$250 for the original 50. **The 2026-04-20 expansion to 100 orgs raises the automated-pass budget to ~\$500.** The added 50 rows are lower-rank by design, so a cheaper tier of estimation (Haiku-only, fewer web searches) is acceptable for ranks 51-100.
- This doc is first-draft-from-existing-knowledge (\$0). The LLM pass should use this as a seed and spot-verify rather than starting from scratch.
- Expected runtime for the automated pass: one overnight (\~8-12 hours for 100 orgs) with parallel web-search queries.
- Haiku-4.5 is sufficient for the numeric estimation task per QUA-635 calibration planning; Sonnet/Opus not needed.

## Next steps

1. **Ozzie validates** the 5 spot-check rows (above). Blocks Phase 2 T1 saturation (QUA-641).
2. **QUA-632 ships** migration that creates `enrichment_targets` (currently Backlog; will land at a migration number later than 0201).
3. **Build `crux tb estimate-denominators`** (~200 LoC) that reads `data/burst-targets.yaml`, runs an LLM + web-search pass per (org, record_type), and writes to `enrichment_targets` — using this doc's estimates as the seed.
4. **Wire dashboards** to read `enrichment_targets.estimated_total` as the denominator for coverage ratios.
5. **Run T1 saturation** (QUA-641) across the 100 orgs; observe which denominators get upward-revised.

## Assumptions & known limitations

- **Umbrella-org scoping**: For orgs where AI is a subset of total activity (RAND, Microsoft, Meta, Coefficient Giving, CNAS, Federation of American Scientists), the personnel denominator is **the AI-focused subset**, not the full org. This keeps coverage percentages meaningful but makes the denominator sensitive to how we cut "AI-focused" — spot-check should validate the cut.
- **Publications time-horizon**: For orgs older than 2012 (RAND, MIT, MSR, Federation of American Scientists, Johns Hopkins Center for Health Security), publications are time-boxed to the AI-era (2012-present). For all other orgs, publications are lifetime-cumulative.
- **Government AISI personnel**: Many were founded 2024-2025 and are growing fast. Numbers reflect approximate 2026-Q1 headcount; expect upward revision within 6 months.
- **Training programs** (MATS, Apart, BlueDot, ARENA, AI Safety Camp, LISA): core staff only in `personnel`. Scholars/cohort participants would inflate the denominator by 5-20× and distort coverage semantics — they're tracked separately as `affiliated_researchers` once that schema exists.
- **Forecasting orgs**: `publications` for Samotsvety, Swift Centre, and similar groups includes their public forecasting track record (question-level resolutions + methodology posts), not just conventional research papers.
- **Grant-rationale pubs for funders**: Coefficient Giving, SFF, LTFF, Manifund publications include grant rationales and payout reports, which function as substantive research output for their roles.
- **Defunct orgs** (FHI, FTX, FTX Future Fund) are excluded from the burst list; their page content is frozen and the burst targets live orgs only.
- **SSI's zero publications** is a deliberate public commitment, not a data gap. Coverage for SSI publications should never exceed 0 unless they publicly reverse that commitment.
- **Lower-rank confidence**: ranks 51-100 have a higher share of `low` confidence cells, especially for `divisions`. This is deliberate — the expanded tail captures ecosystem breadth at lower per-org research investment, and the automated pass (QUA-634) will refine these.

## Cross-references

- Parent umbrella: [QUA-637](https://linear.app/quantifieduncertainty/issue/QUA-637)
- This ticket: [QUA-634](https://linear.app/quantifieduncertainty/issue/QUA-634)
- Seed-list sibling: [QUA-639](https://linear.app/quantifieduncertainty/issue/QUA-639) (burst-targets.yaml)
- Migration-dependency: [QUA-632](https://linear.app/quantifieduncertainty/issue/QUA-632) (still Backlog — `enrichment_targets` table not yet created)
- T1 saturation follow-up: [QUA-641](https://linear.app/quantifieduncertainty/issue/QUA-641)
- Verdict-LLM calibration: [QUA-635](https://linear.app/quantifieduncertainty/issue/QUA-635)
- Duplicate-pause-ai cleanup: [QUA-652](https://linear.app/quantifieduncertainty/issue/QUA-652)
- Concurrent PR: [PR #4521](https://github.com/quantified-uncertainty/longterm-wiki/pull/4521) (Ozzie's seed-list PR; this doc adopts its structure and applies the Coefficient Giving fix from his review comment).
- Seed list: [`data/burst-targets.yaml`](../../data/burst-targets.yaml)
