# ADR-0003 Research — Existing Documentation

## How the gate is supposed to work

`docs/agent-rules/validation-gate-system.md` is the canonical map. It documents four pipelines (`gate`, `data`, `daily`, `unified`) with a clear rule-of-thumb (`docs/agent-rules/validation-gate-system.md:24`): if a check must run on every PR it goes in `gate`; slow/expensive goes in `daily`. The gate orchestrator (`crux/validate/validate-gate.ts`) runs each check as a **separate subprocess** (`docs/agent-rules/validation-gate-system.md:30-43`) — this is what enables `runParallel()` (line 1055) and the `gate-triage.ts` LLM optimization that predicts which checks can be skipped from the diff.

Default posture for the gate as a whole is **fail-closed** (`.claude/rules/error-handling.md:85`). The four documented fail-open exceptions are enumerated by name (`assign-ids`, `typecheck-crux`, `mdx-compile`, `gate-triage`) at `.claude/rules/error-handling.md:88-92`, and each has a one-line rationale.

## When to add a validator

`.claude/rules/implementation-quality.md:51` is the binding rule: **structural change across >5 files → write the validator first**. The four complexity tiers (text/structural/cross-file/runtime) are at `.claude/rules/implementation-quality.md:67-74`. Default disposition is **blocking**; advisory requires a documented reason and ideally a promotion path (`docs/agent-rules/validation-gate-system.md:62`, `validate-gate.ts:599-602` for the entity-refs example "as entity coverage improves, this can be promoted to blocking").

Display-bug regressions specifically must land at one of three checked layers (`.claude/rules/implementation-quality.md:113-118`): `render-audit.spec.ts`, the component test, or `validate-display-formatting.ts`.

## Deletion / demotion / advisory policy

**There is none.** No doc mentions deleting a validator, demoting blocking → advisory after a frontier is held, or moving from gate to runtime invariant. The Charter (`docs/adrs/0003-validator-economics.md:36-42`) explicitly lists these as questions to be answered. The closest existing rules go the opposite direction: silencing a validator is a **symptom-patch red flag** that requires a Linear ticket (`.claude/rules/proactive-github-filing.md:77`), and ≥2 patches silencing the same validator triggers stop-and-escalate (`.claude/rules/proactive-github-filing.md:80`).

## Prior decisions the ADR must respect

1. Default = blocking + fail-closed; any move to advisory or fail-open requires inline documented rationale (precedent set in `validate-gate.ts:283-286`, `593-602`, `666-672`).
2. Baseline-ratchet validators (`sourcing-lint-guard`, `entity-schema-drift`, `typed-client`, `workflow-secrets`, `no-bespoke-filter-chips`) are **designed never to delete** — they hold a frontier. ADR's tier-4 ("delete") cannot apply to these without re-deciding the QUA-103/QUA-770/QUA-1009 ratchet strategy.
3. Each validator's inline comment in `validate-gate.ts` is the historical record of the incident that motivated it. The ADR must read these before recommending deletion (e.g., `fk-swap-double-drop` lines 304-307 cite the migration 0186 deploy halt).

## Gaps the ADR must close

- **Denominator drift**: doc says 52 validators (`docs/agent-rules/validation-gate-system.md:7`, last updated 2026-04-30); Charter says 97. Define which directory contents count.
- **Two-motivation split**: validators added as sweep work-queues (validator-first per `>5 files` rule) versus validators added as point-incident regression-prevention (e.g., `no-sourcinged` covers one non-word) have different deletion criteria. No doc distinguishes them.
- **Runtime-invariant migration policy**: zero documentation on when a Zod schema or DB CHECK should replace a CI validator.
- **Telemetry**: no doc records gate stage timings or per-validator violation rates — both needed to tier-assign by economics rather than by guess.
