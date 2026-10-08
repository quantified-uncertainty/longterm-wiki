# Reviewed entity removal

Reusable discovery, source editing, database execution, verification and recovery
for removing people or organizations while retaining shared works and other entities.

## Discover by name or ID

Set `REMOVAL_DATABASE_URL` explicitly through your private environment, then run:

```sh
node --import tsx/esm crux/lib/reviewed-removal/discover.ts \
  "Person or organization name" --output=/private/path/candidates.json
```

Discovery is read only. Ambiguous names stop the command; use the existing entity
ID to disambiguate. Owned profiles and associations are deletion candidates.
Matches in shared resources, grants or prose require review. Discovery does not
approve deletion or automatically decide which organization employees to remove.

## Prepare and review

Keep each execution bundle outside the repository, with directory permissions
`0700`; its original rows, source copies and receipts contain removed information.
The bundle contains resolved `targets.json`, one physical record per
`reviewed-rows.json` entry, immutable `backups/`, optional reviewed prose/field
overrides, and `draft-plan.json` / `plan.json`.

`snapshot.ts` and `read-metadata.ts` freeze original records and dependencies.
`prepare.ts` produces proposed database and source changes. `refreshPlan()`
accepts source merges while rejecting changed database rows. `validate-sources.ts`
checks YAML, MDX and remaining identities. `finalize.ts` writes the single removal
table and reviewed manifest after validation and rehearsal pass.

The current `rehearse.ts` is the regression harness for the original removal
bundle. It rebuilds its real PostgreSQL schema, applies changes, tests exclusions
and stale-review guards, then checks exact rollback. It only accepts a disposable
database named `removal` on `127.0.0.1`; adapt its fixture-specific assertions for
another removal bundle.

## Execute the exact reviewed plan

```sh
node --import tsx/esm crux/lib/reviewed-removal/cli.ts dry-run PLAN CHECKOUT
node --import tsx/esm crux/lib/reviewed-removal/cli.ts apply PLAN CHECKOUT \
  --approval=REVIEWED_PLAN_SHA256 --receipt=/private/path/apply-receipt.json
```

Apply locks affected tables, verifies original rows and live schema, rejects
unreviewed dependents, clears shared associations, deletes owned records, refreshes
indexes, and installs private import exclusions. Database writes run in one
transaction. `verifyApplied()` checks every committed edit and deletion.

Use `reconcile` after an uncertain commit outcome. `rollback` requires the same
plan digest and an untampered receipt; it rejects intervening changes before
restoring original rows and source files. Source publication remains a normal
feature PR followed by the repository's production release workflow.
