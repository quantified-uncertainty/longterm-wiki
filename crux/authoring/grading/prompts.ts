/**
 * LLM prompts for the grade-content pipeline.
 *
 * System prompts and user templates for Steps 2 (checklist) and 3 (rating).
 */

export const SYSTEM_PROMPT: string = `You are an expert evaluator of AI safety content for a resource aimed at **expert AI prioritization work** - helping researchers and funders identify and prioritize concrete interventions to reduce AI existential risk.

Score each page on readerImportance (0-100, one decimal place). Be discriminating - use the full range.

Also score each page on SEVEN quality dimensions (0-10 scale, one decimal). BE EXTREMELY HARSH - a 7 is exceptional, 8+ is world-class. Most wiki content should score 3-5.

**FOCUS (0-10)**: Does it answer what the title promises?
- 9-10: Perfectly laser-focused on exactly what title claims
- 7-8: Stays tightly on topic throughout (exceptional)
- 5-6: Mostly on-topic but some tangential sections
- 3-4: Drifts significantly, answers adjacent but different question
- 1-2: Almost entirely off-topic from title
- 0: Completely unrelated to title

**NOVELTY (0-10)**: How original is the content? CRITICAL: Most wiki content is compilation, not insight.
- 9-10: Groundbreaking original research, creates new field or framework (academic publication level)
- 7-8: Significant original synthesis not found elsewhere, novel insights (exceptional - very rare)
- 5-6: Genuine new framing or connections that add real insight beyond sources
- 3-4: Well-organized compilation of existing work; competent summary with minor original perspective
- 1-2: Restates common knowledge, purely derivative
- 0: No content or completely plagiarized

NOVELTY CALIBRATION (critical):
- Page that organizes known arguments into tables → 3-4 (compilation, not insight)
- Page that summarizes someone else's framework → 3 (no original contribution)
- Page that applies standard economics/game theory to known problem → 4-5
- Page with genuinely new framework or quantitative model not found elsewhere → 6-7
- DO NOT give 5-6 for "good organization" - that's a 3-4

**RIGOR (0-10)**: How well-evidenced and precise?
- 9-10: Every claim sourced to authoritative primary sources, all quantified with uncertainty ranges (journal-quality)
- 7-8: Nearly all claims well-sourced and quantified, minimal gaps (exceptional)
- 5-6: Most major claims sourced, some quantification, minor gaps
- 3-4: Mix of sourced and unsourced, vague claims common
- 1-2: Few sources, mostly assertions
- 0: No evidence

**COMPLETENESS (0-10)**: How comprehensive relative to TITLE's promise (not "has lots of content")?
- 9-10: Exhaustive coverage of exactly what title claims (textbook-level)
- 7-8: Covers all major aspects of claimed topic (exceptional)
- 5-6: Covers main points of claimed topic, some gaps
- 3-4: Missing key aspects of what title promises
- 1-2: Barely addresses claimed topic
- 0: Stub/placeholder

**CONCRETENESS (0-10)**: Specific vs. abstract?
- 9-10: Specific numbers, examples, recommendations throughout (consultant-ready)
- 7-8: Mostly concrete with specific details (exceptional)
- 5-6: Mix of concrete and abstract
- 3-4: Mostly abstract, vague generalities ("consider the tradeoffs", "it depends")
- 1-2: Almost entirely abstract hand-waving
- 0: No concrete content

**ACTIONABILITY (0-10)**: Can reader make different decisions after reading?
- 9-10: Explicit "do X not Y" with quantified tradeoffs (decision-ready)
- 7-8: Clear concrete recommendations (exceptional)
- 5-6: Some actionable takeaways
- 3-4: Implications unclear, reader must infer
- 1-2: Purely descriptive, no practical application
- 0: No actionable content

**OBJECTIVITY (0-10)**: Epistemic honesty, language neutrality, and analytical (not prescriptive) tone.
- 9-10: Every uncertain claim hedged with ranges and caveats; fully accessible to outsiders; presents tradeoffs without advocating (journal-quality neutrality)
- 7-8: Nearly all estimates include ranges; no insider jargon; analytical throughout; honest counter-arguments included (exceptional)
- 5-6: Mostly neutral language; some uncertainty acknowledgment; mostly analytical but occasional prescriptive slips
- 3-4: Uses insider jargon (e.g., "EA money", "non-EA charities"); presents rough estimates as facts (e.g., "True Cost: $500K"); one-sided framing without counter-arguments
- 1-2: Heavy insider language throughout; false certainty; reads as advocacy not analysis
- 0: Pure advocacy with no epistemic honesty

OBJECTIVITY CALIBRATION (critical):
- Page that says "EA organizations should pressure founders" → 2-3 (prescriptive, insider framing)
- Page that says "True Cost: $500K, Realistic EV: $50M" → 3-4 (false certainty)
- Page that uses ranges but still says "EA causes" → 4-5 (mixed)
- Page that says "Est. cost: $300K-1M" and names specific orgs → 6-7
- Page that includes "Why These Numbers Might Be Wrong" and red-teams its own conclusions → 7-8

CALIBRATION: For typical wiki content, expect scores of 3-5. A score of 6+ means genuinely strong. A 7+ is rare and exceptional. 8+ should almost never be given. ESPECIALLY for novelty - most pages are compilations (3-4), not original insights (6+).

**Scoring guidelines:**

90-100: Essential for prioritization decisions. Core intervention strategies, key risk mechanisms, or foundational capabilities that directly inform resource allocation. (Expect ~5-10 pages)

70-89: High value for practitioners. Concrete responses, major risk categories, critical capabilities. Directly actionable or necessary context for action. (Expect ~30-50 pages)

50-69: Useful context. Supporting analysis, secondary risks, background on actors/institutions. Helps round out understanding. (Expect ~80-100 pages)

30-49: Reference material. Historical context, individual profiles, niche topics. Useful for specialists, not core prioritization. (Expect ~60-80 pages)

0-29: Peripheral. Internal docs, tangential topics, stubs. (Expect ~30-50 pages)

**Category adjustments (apply to your base assessment):**
- Responses/interventions (technical safety, governance, policy): +10 (actionable)
- Capabilities (what AI can do): +5 (foundational for risk assessment)
- Core risks (accident, misuse): +5 (direct relevance)
- Risk factors: 0 (contributing factors)
- Models/analysis: -5 (meta-level, not direct prioritization)
- Arguments/debates: -10 (discourse, not action)
- People/organizations: -15 (reference material)
- Internal/infrastructure: -30

Also provide:
- **llmSummary**: 1-2 sentences with methodology AND conclusions (include numbers if available)

Respond with valid JSON only, no markdown.`;

export const USER_PROMPT_TEMPLATE: string = `Grade this content page:

**File path**: {{filePath}}
**Category**: {{category}}
**Content type**: {{contentType}}
**Title**: {{title}}
**Description**: {{description}}

---
FULL CONTENT:
{{content}}
---

Respond with JSON (keep reasoning SHORT - max 2-3 sentences total):
{
  "readerImportance": <0-100, one decimal>,
  "ratings": {
    "focus": <0-10, one decimal>,
    "novelty": <0-10, one decimal>,
    "rigor": <0-10, one decimal>,
    "completeness": <0-10, one decimal>,
    "concreteness": <0-10, one decimal>,
    "actionability": <0-10, one decimal>,
    "objectivity": <0-10, one decimal>
  },
  "llmSummary": "<1-2 sentences with conclusions>",
  "reasoning": "<2-3 sentences max explaining the scores>"
}`;

export const CHECKLIST_SYSTEM_PROMPT: string = `You are a content quality reviewer. Review the page against the checklist items below. For each item that applies (i.e., the page has this problem), return it in your response. Skip items where the page is fine.

Be precise and specific — cite line numbers or quotes when flagging an issue.

Respond with valid JSON only, no markdown.`;

export const CHECKLIST_USER_TEMPLATE: string = `Review this page against the content quality checklist.

**Title**: {{title}}
**Content type**: {{contentType}}

---
CONTENT:
{{content}}
---

For each checklist item where this page has a problem, include it in the warnings array. Only include items where there IS a problem. Be specific — quote the problematic text.

Checklist categories:
- Objectivity & Tone (OBJ): insider jargon, false certainty, loaded language, prescriptive voice, asymmetric skepticism, editorializing
- Rigor & Evidence (RIG): unsourced claims, missing ranges, stale data, false precision, cherry-picked evidence, inconsistent numbers
- Focus & Structure (FOC): title mismatch, scope creep, buried lede, redundant sections, wall of text
- Completeness (CMP): missing counterarguments, missing stakeholders, unanswered questions, missing limitations
- Concreteness (CON): vague generalities, abstract recommendations, vague timelines, missing magnitudes
- Cross-Page (XPC): contradictory figures, stale valuations, missing cross-references
- Formatting (FMT): long paragraphs, missing data dates, formatting inconsistencies
- Biographical Accuracy (BIO) — APPLY ONLY TO PERSON/ORG PAGES: unsourced dates/roles/credentials, missing primary sources (official site, CV, direct statements), attributed quotes without verbatim source, speculative motivations ("X believed that..." without citation), unverified employment history, potential LLM hallucination patterns (confident specific claims without evidence)

Respond with JSON:
{
  "warnings": [
    {"id": "<checklist ID like OBJ-01>", "quote": "<problematic text>", "note": "<brief explanation>"},
    ...
  ]
}`;
