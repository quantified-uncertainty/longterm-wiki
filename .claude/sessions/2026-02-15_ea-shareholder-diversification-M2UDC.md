## 2026-02-15 | claude/ea-shareholder-diversification-M2UDC | EA shareholder diversification page

**What was done:** Created a new wiki page analyzing EA shareholder diversification strategies (E694). Added "Employee Tax Urgency" section to DAF Transfers page (E412). Then performed detailed editorial review and fixed critical errors: 409A valuations corrected from preferred to common stock values, ISO/DAF interaction rewritten (can't donate unexercised ISOs), QSBS California non-conformance added, AMT rate corrected to include CA AMT, math errors fixed throughout diversification page, removed fabricated "Senterra Funders" entity, added missing E411 cross-reference.

**Pages:** ea-shareholder-diversification-anthropic, anthropic-pre-ipo-daf-transfers

**Issues encountered:**
- Crux content pipeline synthesis fails (nested claude session). Wrote pages manually.
- Initial tax section had multiple critical errors caught in review (see learnings).

**Learnings/notes:**
- 409A valuations are 30-60% BELOW preferred stock price. Never use secondary market prices as 409A FMV.
- California does NOT conform to IRC Section 1202 (QSBS). Federal savings only.
- Unexercised ISOs cannot be donated to DAFs. AMT triggers at exercise regardless.
- AMT rate should include CA AMT (~7%), making combined rate ~35%, not 28%.
- E408 is musk-openai-lawsuit, NOT anthropic-pre-ipo-daf-transfers (which is E412).
- The `crux content create` tiers are `budget`, `standard`, `premium` (not `polish`).
