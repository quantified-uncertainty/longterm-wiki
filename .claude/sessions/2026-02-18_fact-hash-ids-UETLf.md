## 2026-02-18 | claude/fact-hash-ids-UETLf | Migrate fact IDs from human-readable to hash-based

**What was done:** Migrated all canonical fact IDs from human-readable slugs (e.g., `revenue-arr-2025`) to 8-char random hex hashes (e.g., `55d88868`), matching the pattern used by resources. Updated all YAML files, MDX references, build scripts, tests, LLM prompts, and documentation.

**Pages:** canonical-facts, anthropic-ipo, anthropic-valuation, anthropic-investors, anthropic, sam-altman, diagrams

**Model:** opus-4-6

**Duration:** ~45min

**Issues encountered:**
- YAML stringify expanded scientific notation values (380e9 → 380000000000) — functionally equivalent but less readable in source
- Build script required running from `app/` directory with tsx loader

**Learnings/notes:**
- The measure auto-inference from fact ID prefixes is now dead code (replaced with explicit `measure:` fields). All migrated facts have explicit measures where they were previously inferred.
- `generateFactId()` utility added to `crux/resource-utils.ts` for creating new facts
- Migration mapping saved to `scripts/fact-id-mapping.json` for reference
