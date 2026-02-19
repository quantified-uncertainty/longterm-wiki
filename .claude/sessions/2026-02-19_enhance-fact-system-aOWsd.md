## 2026-02-19 | claude/enhance-fact-system-aOWsd | Enhanced Anthropic stakeholders table with HoverCards, entity previews, full-bleed layout

**What was done:** Multi-round enhancement of the Anthropic stakeholders page. Session 1: added 5 canonical facts, refactored table into server+client split, column toggles, pledge ranges. Session 2: replaced FactRef hash badges with Radix HoverCard popovers on values (interactive, stays open); added EntityPreviewLink hover cards on stakeholder names; added live valuation input so users can recalculate at custom valuations; added `contentFormat: table` + `hideSidebar: true` to hide left sidebar and give table full container width; added `prose-constrain-text` CSS to keep text at 65rem while table component uses full 90rem container; fixed EA connections (Chris Olah and Jack Clark upgraded to "Moderate"; Tom/Jared/Sam updated to "Weak/unknown" with reasoning); added Methodology & Assumptions section explaining how all estimates were derived.

**Pages:** anthropic-stakeholders

**Model:** sonnet-4-6

**Duration:** ~2h (two sessions)

**Issues encountered:**
- `getFact()` uses `fs.readFileSync` — server/client split required; server wrapper now passes all facts + entity previews as serializable props.
- Remote branch kept being force-pushed by auto-rebase during long pre-push builds; solved with `git stash && git pull --rebase && git stash pop` then `--force-with-lease`.
- Dollar signs in new methodology section needed `\$` escaping — caught by `pnpm crux fix escaping`.

**Learnings/notes:**
- Radix `@radix-ui/react-hover-card` is already installed and is the right component for interactive popovers (unlike CSS `pointer-events-none` tooltips that disappear when cursor moves).
- `hideSidebar: true` in MDX frontmatter + handling in `page.tsx` `WithSidebar` gives targeted sidebar control per-page.
- `prose-constrain-text` CSS (max-width: 65rem on `>p/h2/ul/table`) lets text stay narrow while React component `<div>`s use the full container width.
