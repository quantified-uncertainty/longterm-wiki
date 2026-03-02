# Page Authoring

**Always use the Crux content pipeline.** Do not manually write wiki pages from scratch.

```bash
pnpm crux content create "Page Title" --tier=standard    # budget | standard | premium
pnpm crux content improve <page-id> --tier=standard --apply  # polish | standard | deep
```

**If the pipeline fails, fix the pipeline** — do not bypass it. See the crux source code in `crux/` to diagnose and fix issues. Manually written pages are missing citations, EntityLink validation, frontmatter syncing, and quality grading.

Session logs are written automatically after `--apply` runs. Do not also run `/agent-session-ready-PR` for improve-only sessions.

The improve pipeline includes a **semantic diff safety check** (`crux/lib/semantic-diff/`) that automatically runs after `--apply`. It extracts factual claims before and after modification, diffs them, and checks for contradictions. Warnings are logged but writes are never blocked. Snapshots are stored in `.claude/snapshots/` (gitignored) for post-hoc auditing.

## After any page edit

Run `pnpm crux fix escaping` and `pnpm crux fix markdown`, then verify with `pnpm crux validate gate --fix`.

**Six checks are CI-blocking:** comparison-operators, dollar-signs, schema, frontmatter-schema, numeric-id-integrity, prefer-entitylink. All are included in the gate.

## Self-review checklist (before committing any page)

1. **Links resolve**: Every `<EntityLink id="X">` has a matching entity in `data/entities/*.yaml`
2. **Prose matches data**: Claims agree with numbers in tables/charts on the same page
3. **No `{/* NEEDS CITATION */}` markers**: Search before committing
4. **Cross-page consistency**: If you edited a person page, check the linked org page for conflicts
5. **MDX rendering**: For `\$`, `^`, `{}` — think through rendering. When in doubt, use plain text
