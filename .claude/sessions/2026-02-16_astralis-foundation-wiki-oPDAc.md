## 2026-02-16 | claude/astralis-foundation-wiki-oPDAc | Add Astralis Foundation wiki page

**What was done:** Created a new wiki page for the Astralis Foundation, a Swedish AI safety and governance philanthropy. Added the organization entity to YAML with connections to Longview Philanthropy, Rethink Priorities, Beth Barnes, and METR.

**Pages:** astralis-foundation

**Issues encountered:**
- Crux content create pipeline failed: Perplexity research phase returned "fetch failed" (likely network restrictions in sandbox)
- Tried `--source-file` workaround which loaded research successfully, but synthesis phase failed because it spawns a nested `claude` subprocess which is blocked inside an existing Claude Code session
- Wrote page manually using research gathered via WebFetch from astralisfoundation.org, then ran fix/validation pipeline

**Learnings/notes:**
- The crux content create pipeline cannot work inside a Claude Code web session because the synthesis phase spawns a nested `claude` CLI process, which is explicitly blocked
- The `--source-file` flag successfully skips all network research phases, but the synthesis subprocess remains a blocker
- Workaround: write page manually following organization page template structure, then run `crux fix escaping`, `crux fix markdown`, and all three blocking validators
