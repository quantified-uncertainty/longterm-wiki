## 2026-02-15 | claude/ea-shareholder-diversification-M2UDC | EA shareholder diversification page

**What was done:** Created diversification page (E697), added tax section to DAF Transfers (E412), created EA Funding Absorption Capacity (E695) and FTX Collapse Lessons (E696). Performed three rounds of review: (1) tax error fixes, (2) diversification page fixes, (3) cross-page consistency audit fixing broken EntityLinks, valuation inconsistencies, and missing cross-references.

**Pages:** ea-shareholder-diversification-anthropic, anthropic-pre-ipo-daf-transfers, ea-funding-absorption-capacity, ftx-collapse-ea-funding-lessons

**Issues encountered:**
- Crux content pipeline synthesis fails (nested claude session). Wrote pages manually.
- Linter reassigned diversification page from E694 to E697, breaking four EntityLinks across two pages that referenced E694.
- DAF Transfers page used $350B valuation while all other pages used $380B — inconsistency persisted through two review rounds before being caught.
- FTX Future Fund operated ~9 months, not annually — "$100-200M/year committed" was misleading.

**Learnings/notes:**
- 409A valuations are 30-60% BELOW preferred stock price. Never use secondary market prices as 409A FMV.
- California does NOT conform to IRC Section 1202 (QSBS). Federal savings only.
- Unexercised ISOs cannot be donated to DAFs. AMT triggers at exercise regardless.
- AMT rate should include CA AMT (~7%), making combined rate ~35%, not 28%.
- **CRITICAL: After linter runs, check id-registry.json for reassigned IDs.** Linter can change numericIds, breaking EntityLinks. Always verify `E###` IDs match registry after any linter modification.
- When creating multiple pages in a cluster, set a single canonical valuation and use it everywhere. Update ALL pages together when valuation changes.
- E408 is musk-openai-lawsuit, NOT anthropic-pre-ipo-daf-transfers (which is E412).
- The `crux content create` tiers are `budget`, `standard`, `premium` (not `polish`).
