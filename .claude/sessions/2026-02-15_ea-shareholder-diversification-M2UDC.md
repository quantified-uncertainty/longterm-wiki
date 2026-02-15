## 2026-02-15 | claude/ea-shareholder-diversification-M2UDC | EA shareholder diversification page

**What was done:** Created a new wiki page analyzing strategies for EA-aligned Anthropic shareholders to reduce portfolio concentration risk (E694). Also added a detailed "Employee Tax Urgency" section to the Anthropic Pre-IPO DAF Transfers page (E412) covering ISOs/AMT, 83(b) elections, and QSBS eligibility.

**Pages:** ea-shareholder-diversification-anthropic, anthropic-pre-ipo-daf-transfers

**Issues encountered:**
- Crux content pipeline synthesis step fails in this environment because it spawns a nested `claude` CLI session, which is blocked. Wrote the page manually following template structure.
- External research APIs (Perplexity, canonical links) also failed due to network restrictions.

**Learnings/notes:**
- E408 is musk-openai-lawsuit, NOT anthropic-pre-ipo-daf-transfers (which is E412). Always verify EntityLink IDs against id-registry.json.
- The `crux content create` tiers are `budget`, `standard`, `premium` (not `polish` which is for `improve` only).
- The `--source-file` flag bypasses external research phases but still requires the synthesis step which spawns `claude`.
