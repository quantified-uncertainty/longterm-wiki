#!/usr/bin/env node

/**
 * Gate Validation — CI-blocking checks in one command
 *
 * Runs the same checks that CI enforces, locally, before push.
 * Used by .githooks/pre-push to mechanically block bad pushes.
 *
 * Steps (fast mode, default):
 *   0. Triage — categorize diff, optionally ask Haiku which checks to skip
 *   1. Build data layer (required for validation + tests) — skippable if only crux/ changed
 *   2. Auto-fix escaping + markdown (with --fix)
 *   3. [Parallel] Run vitest tests
 *      [Parallel] Unified blocking rules (MDX syntax, frontmatter, wiki IDs, EntityLink)
 *      [Parallel] YAML schema validation
 *      [Parallel] TypeScript type check — app
 *      [Parallel] TypeScript type check — crux
 *
 * With --full:
 *   4. Full Next.js production build
 *
 * Flags:
 *   --full-gate    Force all checks, no triage (implies --no-triage, --no-cache)
 *   --no-triage    Skip LLM triage call, run all checks
 *   --no-cache     Ignore stamp cache, force full re-run
 *   --fix          Auto-fix escaping + markdown before validation
 *   --full         Include full Next.js production build
 *   --ci           JSON output for CI pipelines (implies --no-cache)
 *   --scope=content  Content-only: skip build-data/tests/typechecks, run only
 *                    unified-blocking + yaml-schema (no stamp cache written)
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = One or more checks failed
 */

import { execSync, execFileSync, spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { PROJECT_ROOT } from '../lib/content-types.ts';

// Load .env so child validators inherit PROD_LONGTERMWIKI_SERVER_URL etc.
// Without this, validators that fetch from wiki-server fall back to the local
// snapshot (often stale), which manifests as gate-baseline-drift between
// local and CI. See QUA-755. Falls back to fileURLToPath(import.meta.url) when
// import.meta.dirname is undefined (older tsx CJS transforms).
const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
dotenvConfig({
  path: resolve(HERE, '..', '..', '.env'),
  quiet: true,
  override: false,
});
import { getColors } from '../lib/output.ts';
import { categorizeFiles, canSkipBuildData, triageGateChecks, type TriageResult } from './gate-triage.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';

/**
 * Find the tsc binary. Prefers the local copy in apps/web/node_modules
 * (where TypeScript is installed as a dependency) over npx, which fails
 * in worktrees without a local node_modules.
 */
function findTsc(): { command: string; args: string[] } {
  const localTsc = join(PROJECT_ROOT, 'apps/web/node_modules/.bin/tsc');
  if (existsSync(localTsc)) return { command: localTsc, args: [] };
  // Fallback: npx (works when node_modules is present or tsc is global)
  return { command: 'npx', args: ['tsc'] };
}

const args: string[] = process.argv.slice(2);
const FIX_MODE: boolean = args.includes('--fix');
const CI_MODE: boolean = args.includes('--ci') || process.env.CI === 'true';
const FULL_GATE: boolean = args.includes('--full-gate');
const NO_TRIAGE: boolean = args.includes('--no-triage') || FULL_GATE || CI_MODE;
const NO_CACHE: boolean = args.includes('--no-cache') || FULL_GATE || CI_MODE;
const SCOPE: string = args.find(a => a.startsWith('--scope='))?.split('=')[1] || '';
const CONTENT_ONLY: boolean = SCOPE === 'content';

// ── Stamp-based caching ──────────────────────────────────────────────────────
// After a successful gate run, we write the HEAD tree hash + mode to a stamp
// file inside .git/. On subsequent runs, if the tree hash hasn't changed and
// the mode is compatible, we skip the entire gate. Using tree hash (not commit
// hash) means rebases that don't change content still hit the cache, avoiding
// the race condition where a 200s gate pass is invalidated by a rebase onto
// updated main (#1821).

const STAMP_FILE = join(PROJECT_ROOT, '.git', 'gate-stamp');

function getHeadHash(): string {
  try {
    // Use tree hash so rebases with identical content still hit the cache
    return execSync('git rev-parse HEAD^{tree}', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
  } catch {
    // Fail-closed: empty hash means stamp cache won't match, so gate runs fully
    return '';
  }
}

function readStamp(): { hash: string; mode: string } | null {
  try {
    const content = readFileSync(STAMP_FILE, 'utf-8').trim();
    const [hash, mode] = content.split(' ');
    if (hash && mode) return { hash, mode };
    return null;
  } catch {
    // Fail-closed: no stamp means gate runs fully (no cache hit)
    return null;
  }
}

function writeStamp(hash: string, mode: string): void {
  try {
    writeFileSync(STAMP_FILE, `${hash} ${mode}\n`);
  } catch {
    // Non-fatal: stamp write failure just means next push will re-run the gate
  }
}

/**
 * Get the list of files changed on this branch vs main.
 * Reused by shouldAutoEscalateToFull() and the triage phase.
 */
function getChangedFiles(): string[] {
  try {
    let diffOutput = '';
    try {
      const base = execSync('git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null',
        { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
      if (base) {
        diffOutput = execFileSync('git', ['diff', '--name-only', base, 'HEAD'],
          { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
      }
    } catch {
      diffOutput = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null || echo ""',
        { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
    }
    if (!diffOutput) return [];
    return diffOutput.split('\n').filter(Boolean);
  } catch {
    // Fail-closed: empty file list means no triage optimization, all checks run
    return [];
  }
}

/**
 * Auto-detect whether --full (Next.js build) is needed based on changed files.
 * Triggers when the diff includes app page components or data files that are
 * prerendered at build time (e.g. auto-update YAML that dashboards read).
 */
function shouldAutoEscalateToFull(files: string[]): boolean {
  return files.some(f =>
    // App page components (prerendered by Next.js)
    f.startsWith('apps/web/src/app/') ||
    // Auto-update run data (read by dashboard pages at build time)
    f.startsWith('data/auto-update/runs/') ||
    // Auto-update state/sources (read by dashboard pages at build time)
    (f.startsWith('data/auto-update/') && f.endsWith('.yaml'))
  );
}

const changedFiles = getChangedFiles();
const EXPLICIT_FULL: boolean = args.includes('--full');
const AUTO_FULL: boolean = !EXPLICIT_FULL && shouldAutoEscalateToFull(changedFiles);
const FULL_MODE: boolean = EXPLICIT_FULL || AUTO_FULL;

const c = getColors(CI_MODE);

interface Step {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  advisory?: boolean; // if true, failure is reported but doesn't block
  emitOutputInCi?: boolean; // print captured output in CI even on success
  requiresServer?: boolean; // if true, auto-advisory when wiki-server is unreachable
}

const APP_DIR = `${PROJECT_ROOT}/apps/web`;
const tsc = findTsc();

// Phase 0.5: Assign IDs from wiki-server before build-data
const ASSIGN_IDS_STEP: Step = {
  id: 'assign-ids',
  name: 'Assign entity IDs from server',
  command: 'node',
  args: ['--import', 'tsx/esm', 'scripts/assign-ids.mjs'],
  cwd: APP_DIR,
  // Fail-open: ID assignment depends on the wiki-server being reachable.
  // If the server is unavailable, build-data has its own local fallback
  // (max-id-from-YAML + 1). Blocking the gate on server availability would
  // break offline development.
  advisory: true,
};

// Phase 1: Must run first — everything else depends on this
const BUILD_DATA_STEP: Step = {
  id: 'build-data',
  name: 'Build data layer',
  command: 'node',
  args: ['--import', 'tsx/esm', 'scripts/build-data.mjs'],
  cwd: APP_DIR,
};

// Phase 2 (--fix only): Auto-fix before validation
const FIX_STEPS: Step[] = [
  {
    id: 'fix-escaping',
    name: 'Auto-fix escaping',
    command: 'pnpm',
    args: ['crux', 'fix', 'escaping'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'fix-markdown',
    name: 'Auto-fix markdown',
    command: 'pnpm',
    args: ['crux', 'fix', 'markdown'],
    cwd: PROJECT_ROOT,
  },
];

// Blocking unified rules — merged into one subprocess invocation so MDX files are
// loaded once instead of once-per-rule. Add new CI-blocking rules here.
const UNIFIED_BLOCKING_RULES = [
  'comparison-operators',
  'dollar-signs',
  'entitylink-ids',
  'footnote-integrity',
  'frontmatter-schema',
  'kbf-refs',
  'no-deprecated-components',
  'no-quoted-subcategory',
  'wiki-id-integrity',
  'pipeline-artifacts',
  'prefer-entitylink',
  'resource-ref-integrity',
  'url-safety',
];

// Phase 3: Independent checks — run in parallel after build-data completes.
// All steps in this group always run to completion so all errors are reported at once.
const PARALLEL_STEPS: Step[] = [
  {
    id: 'test',
    name: 'Run tests',
    command: 'pnpm',
    args: ['test'],
    cwd: APP_DIR,
  },
  {
    id: 'unified-blocking',
    name: 'Unified blocking rules (MDX syntax, frontmatter, wiki IDs, EntityLink, pipeline artifacts)',
    command: 'pnpm',
    args: [
      'crux', 'validate', 'unified',
      `--rules=${UNIFIED_BLOCKING_RULES.join(',')}`,
      '--errors-only',
    ],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'yaml-schema',
    name: 'YAML schema (blocking)',
    command: 'pnpm',
    args: ['crux', 'validate', 'schema'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'typecheck',
    name: 'TypeScript type check — app',
    command: tsc.command,
    args: [...tsc.args, '--noEmit'],
    cwd: APP_DIR,
  },
  {
    id: 'typecheck-crux',
    name: 'TypeScript type check — crux (advisory)',
    command: tsc.command,
    args: [...tsc.args, '--noEmit', '-p', '../../crux/tsconfig.json'],
    cwd: APP_DIR,
    // Fail-open: crux has its own tsconfig with relaxed settings and
    // a known baseline of pre-existing errors. Blocking on crux type
    // errors would prevent shipping app-only fixes.
    advisory: true,
  },
  {
    id: 'returning-guard',
    name: '.returning() guard check',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-returning-guard.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'drizzle-journal',
    name: 'Drizzle migration journal integrity',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-drizzle-journal.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    // The generated db-schema-reference.mdx is derived from schema.ts. Blocking
    // so the schema and its reference page can never drift the way the
    // hand-written db-schema-overview.mdx did (documented 42 tables while the
    // schema grew to 114). Regenerate with: pnpm crux generate db-schema-docs
    id: 'db-schema-docs-fresh',
    name: 'DB schema reference page is in sync with schema.ts',
    command: 'npx',
    args: ['tsx', 'crux/generate/generate-db-schema-docs.ts', '--check'],
    cwd: PROJECT_ROOT,
  },
  {
    // QUA-609: enforces FK-swap migrations drop BOTH the Drizzle-generated
    // `<table>_<col>_resources_id_fk` AND the postgres-default
    // `<table>_<col>_fkey` names. Migration 0186 only dropped the first and
    // halted production. Blocking — the deploy-halt cost makes any bypass
    // strictly worse than the small surface this rule covers.
    id: 'fk-swap-double-drop',
    name: 'FK-swap migrations drop both _fk and _fkey names',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-fk-swap-double-drop.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    // Rationale in validate-workspace-dep-coverage.ts. QUA-598.
    id: 'workspace-dep-coverage',
    name: 'Workspace dependency coverage (no undeclared @longterm-wiki/* imports)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-workspace-dep-coverage.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    // QUA-294: enforces NOT VALID on ADD CONSTRAINT for large tables.
    // Migration 0173 caused a ~12h prod deploy stall by taking ACCESS
    // EXCLUSIVE on hallucination_risk_snapshots without NOT VALID.
    // Blocking — there is no legitimate reason to bypass this on a hot
    // table. If a new large table appears, add it to LARGE_TABLES in the
    // validator file.
    id: 'migration-large-table-ddl',
    name: 'Migration NOT VALID required on large tables',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-migration-large-table-ddl.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'untyped-rows',
    name: 'No untyped row casts in routes',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-untyped-rows.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'no-console-log',
    name: 'No console.log in server code',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-no-console-log.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    // QUA-1006: directory tables must use shared formatters from
    // @/lib/format-compact + @/lib/format. Prevents new ad-hoc
    // .toLocaleString / Intl.NumberFormat / .toLocaleDateString calls
    // from drifting back into *-table.tsx components.
    id: 'table-formatting',
    name: 'Directory tables use shared formatters (QUA-1006)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-table-formatting.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    // QUA-897: block the non-word "sourcinged" — a mass-rename artifact
    // from QUA-237 that surfaced on /divisions and 4 other pages.
    id: 'no-sourcinged',
    name: 'No "sourcinged" non-word (QUA-897 regression check)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-no-sourcinged.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    // QUA-730: any newly added/modified manifest in data/tablebase-manifests/
    // must have at least one record with sourcing data. Catches the
    // "agent ran with --skip-sourcing because the billing key was missing"
    // failure mode (PR #4612, all 81 records shipped with verdict=none).
    id: 'manifest-sourcing',
    name: 'TableBase manifest sourcing (no all-unverified bulk drops)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-manifest-sourcing.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    // QUA-700: catches `${{ secrets.X }}` references in workflow YAMLs that
    // don't resolve to a real repo or org-inherited secret (the QUA-676
    // root cause). Advisory because (a) forks/local environments lack gh
    // auth — the validator fails open in that case anyway — and (b) at
    // ship time there are 17 pre-existing pending references being tracked
    // for cleanup. Flip to blocking once the existing list is at zero.
    id: 'workflow-secrets',
    name: 'Workflow secret references resolve',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-workflow-secrets.ts'],
    cwd: PROJECT_ROOT,
    advisory: true,
  },
  {
    // QUA-388: ESLint with @typescript-eslint/no-floating-promises.
    // Blocking. Catches unhandled-promise patterns that ranked highest
    // in the PR-review survey (~18% of findings). Each future rule
    // (no-misused-promises, import/no-unresolved, etc.) lands as its
    // own follow-up PR.
    id: 'eslint',
    name: 'ESLint (no-floating-promises)',
    command: 'pnpm',
    args: ['lint'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'no-anthropic-api-key-read',
    name: 'No raw Anthropic CLI env-var reads in source (QUA-612)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-no-anthropic-api-key-read.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'url-normalize',
    name: 'URL normalization helpers consolidated (QUA-341)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-url-normalize.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: prevents new local normalizeUrl helpers from re-fragmenting
    // the canonical helper in @longterm-wiki/url-utils.
  },
  {
    id: 'sourcing-lint-guard',
    name: 'Sourcing rename ratchet (legacy terminology counts only fall)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-sourcing-lint-guard.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: prevents new legacy-term references from accumulating
    // while the rename (QUA-102, QUA-105..QUA-109) is parked. Baseline
    // at crux/validate/.sourcing-baseline.json — only adjusts downward.
    // See QUA-103 for context.
  },
  {
    id: 'inline-pagination',
    name: 'No inline limit clamping in routes (use clampedLimit)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-inline-pagination.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'entity-schema-drift',
    name: 'Entity-schema drift in tablebase routes',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-entity-schema-drift.ts'],
    cwd: PROJECT_ROOT,
    // Blocking. Bans new `const VALID_*` and inline `z.enum([` in
    // apps/wiki-server/src/routes/tablebase/ outside the allowlist at
    // crux/validate/.entity-schema-drift-allowlist.txt. Existing entries can
    // be removed when a route is migrated to a shared canonical schema, but
    // there is no active plan driving the allowlist to zero (the QUA-943 v5
    // plan that originally drove this was rejected — see QUA-1043).
    // Suppress per-line legitimate uses (e.g., query enums) with
    // `// schema-drift-ok`.
  },
  {
    id: 'prompt-escaping',
    name: 'Prompt XML interpolation escaping',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-prompt-escaping.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'verdict-priority',
    name: 'Verdict severity priority is canonical (QUA-429)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-verdict-priority.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: prevents new ad-hoc verdict priority maps from drifting from
    // SOURCE_CHECK_VERDICT_PRIORITY in verdict-styles.ts. Distinct priorities
    // (recheck scheduling, curation order) opt out via `// verdict-priority-ok`.
  },
  {
    id: 'dangerous-patterns',
    name: 'Data-integrity anti-patterns (silent catch, as any in routes, skipEntityValidation without reason)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-dangerous-patterns.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'typed-client',
    name: 'Direct apiRequest<T> calls (QUA-770) — must use typed wiki-server client or // typed-client-ok marker',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-typed-client.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: prevents new hand-written apiRequest<T> calls from
    // bypassing the typed wiki-server client modules. Existing callers
    // are annotated with // typed-client-ok: <reason> as a baseline;
    // see QUA-770 for the migration plan.
  },
  {
    id: 'no-bespoke-filter-chips',
    name: 'No new bespoke filter-chip rows (QUA-1009) — use <FilterChips> from @/components/directory',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-no-bespoke-filter-chips.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: locks down the QUA-1009 sweep. Bans the
    // `ml-1 text-[10px] opacity-60` chip-count signature anywhere
    // outside the canonical components. Annotate per-line with
    // `// filter-chip-ok: <reason>` for the rare bespoke chip with
    // genuinely custom UX (see organizations-view.tsx).
  },
  {
    id: 'factbase-stableid',
    name: 'FactBase lookups use stableIds (not slugs)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-factbase-stableid.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'third-party-eval-refs',
    name: 'third_party_evaluations vocab arrays match route ↔ migration (QUA-692)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-third-party-eval-refs.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: a vocab drift between the Zod schema in the route and the
    // CHECK constraint in the migration shows up at sync time as a 500
    // error from PG. Static-checkable, so we keep it cheap and CI-blocking.
  },
  {
    id: 'policy-stakeholders-strict',
    name: 'Policy stakeholders strict Zod schema (QUA-964 / QUA-941 bridge)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-policy-stakeholders-strict.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: runs the canonical sync-route Zod schema against every
    // policy.stakeholders[] block in data/entities/. QUA-941 shipped 10
    // rows of `position: reform` that the route silently rejected with a
    // 400 and the build helper swallowed; this gate catches the same class
    // of mistake at PR-review time. Companion fix in
    // apps/web/scripts/lib/wiki-server-data.mjs makes runtime sync 400s
    // also fail loud.
  },
  {
    id: 'things-denorm-dead',
    name: 'No writes/reads of dropped things.title/description/parent_title (QUA-507)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-things-denorm-dead.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'factbase-fact-unit-field',
    name: 'FactBase facts use `currency:` not `unit:` (loader drops stray unit fields)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-factbase-fact-unit-field.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: `unit:` at a fact top-level is silently dropped by the loader,
    // causing currency symbol mismatches (QUA-620: £5M fact rendered as $5M).
  },
  {
    id: 'dot-position',
    name: 'Dot indicator position (SourcingDot / RecordStatusDots not in first column)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-dot-position.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: dots in the first column confuse visual scanning. The validator
    // checks both HTML <td> tables and TanStack ColumnDef arrays.
  },
  {
    id: 'mdx-compile',
    name: 'MDX compilation smoke-test',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-mdx-compile.ts', '--quick'],
    cwd: PROJECT_ROOT,
    // Blocking: MDX compilation errors broke main 4 times in the week of
    // 2026-03-23 (#3275, #3280, #3285, #3307). Promoting to blocking
    // catches these before push. If false positives appear, add specific
    // exclusions in validate-mdx-compile.ts rather than demoting back to advisory.
  },
  {
    id: 'component-refs',
    name: 'Component reference validation',
    command: 'pnpm',
    args: ['crux', 'validate', 'refs'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'kb-schema',
    name: 'KB schema validation (required properties, ref integrity, data quality)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-factbase-schema.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'entity-refs',
    name: 'Entity reference integrity (KB records)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-entity-refs.ts'],
    cwd: PROJECT_ROOT,
    // Advisory: many record endpoint fields intentionally use display names
    // or slug strings that aren't modeled as KB entities yet. As entity
    // coverage improves, this can be promoted to blocking.
    advisory: true,
  },
  {
    id: 'factbase-entities',
    name: 'FactBase entity coverage (every FactBase file has TableBase entry)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-factbase-entities.ts'],
    cwd: PROJECT_ROOT,
    // Advisory until all FactBase entities are confirmed in TableBase
    advisory: true,
  },
  {
    id: 'factbase-entity-ids',
    name: 'FactBase ↔ TableBase entity ID consistency (duplicates, stableId mismatches)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-factbase-entity-ids.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: stableId mismatches and duplicate entity IDs cause financial data
    // to silently disappear from directory pages (facts join on stableId).
  },
  {
    id: 'kb-entity-slugs',
    name: 'KB entity slug validation (FactBase refs have entity registry entries)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-kb-entity-slugs.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: FactBase !ref values that point to stableIds without entity
    // registry entries cause broken links and missing entity data in the UI.
  },
  {
    id: 'yaml-entity-refs',
    name: 'YAML entity reference integrity (relatedEntries, developer, affiliation)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-yaml-entity-refs.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: dangling entity references cause broken links and raw IDs
    // displayed in the UI. Regressions should be caught immediately.
  },
  {
    id: 'temporal-invariants',
    name: 'Temporal invariant validation (date validity, ordering)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-temporal.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: invalid or misordered dates (e.g., endDate before startDate,
    // future dates on historical events) should be caught immediately.
  },
  {
    id: 'directory-pages',
    name: 'Directory page data quality (advisory)',
    command: 'pnpm',
    args: ['crux', 'validate', 'directory-pages'],
    cwd: PROJECT_ROOT,
    // Advisory: reports sparse directories, missing fields, and display issues
    // in entity directory pages. Informational for now — can be promoted to
    // blocking once all existing issues are resolved.
    advisory: true,
    emitOutputInCi: true,
  },
  {
    id: 'orphan-entities',
    name: 'Orphan entity detection (PG records without YAML source)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-orphan-entities.ts'],
    cwd: PROJECT_ROOT,
    // Advisory: depends on wiki-server being reachable. The check skips
    // gracefully when the server is unavailable (fail-open). Promotes to
    // blocking once orphan entities are consistently zero.
    advisory: true,
    requiresServer: true,
    emitOutputInCi: true,
  },
  {
    id: 'scorecard-refs',
    name: 'Scorecard data integrity (is_latest invariant + entity refs)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-scorecard-refs.ts'],
    cwd: PROJECT_ROOT,
    // Advisory: requires the wiki-server (scorecard tables live only in PG).
    // Skips silently when offline. QUA-688 — will promote to blocking once
    // ingesters land and the data baseline stabilizes.
    advisory: true,
    requiresServer: true,
    emitOutputInCi: true,
  },
  {
    id: 'framework-thresholds',
    name: 'Framework capability threshold integrity (source_quote verified or human-reviewed)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-framework-thresholds.ts'],
    cwd: PROJECT_ROOT,
    // Blocking (QUA-711): every published threshold must have either
    // extraction_confidence ≥ 0.7 (verifyExcerpt round-trip succeeded at
    // extract time) or human_reviewed=true with non-empty human_review_notes.
    // No-ops while no rows are published yet. Requires wiki-server.
    requiresServer: true,
    emitOutputInCi: true,
  },
  {
    id: 'framework-versions',
    name: 'Framework version archival integrity (wayback_snapshot_url or notes)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-framework-versions.ts'],
    cwd: PROJECT_ROOT,
    // Blocking (QUA-711): every published safety_framework_versions row must
    // have either wayback_snapshot_url populated or notes flagging Wayback
    // skipped. No-ops while no rows are published yet. Requires wiki-server.
    requiresServer: true,
    emitOutputInCi: true,
  },
  {
    id: 'sid-display',
    name: 'No sid_ values in display name columns',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-sid-display.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: display name columns must never contain sid_-prefixed stableIds.
    // The sid_ prefix makes detection trivial. If any display column has a sid_
    // value, it means the enrichment pipeline wrote a stableId where a human-
    // readable name should be. Requires wiki-server for API queries.
    requiresServer: true,
  },
  {
    id: 'factbase-record-refs',
    name: 'FactBase record ref resolution (no unresolvable sid_ IDs in record fields)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-factbase-record-refs.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: unresolvable entity references in FactBase records cause
    // raw sid_ IDs to display in the UI on entity pages.
  },
  {
    id: 'soft-fks',
    name: 'Soft FK entity reference validation (advisory)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-soft-fks.ts'],
    cwd: PROJECT_ROOT,
    // Advisory: requires wiki-server access. Reports legacy text FK fields
    // in PG tables (personnel, grants, investments, etc.) that don't resolve
    // to known entities. Informational for now.
    advisory: true,
    requiresServer: true,
    emitOutputInCi: true,
  },
  {
    id: 'controlled-vocab',
    name: 'Controlled vocabulary validation',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-controlled-vocab.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: all entity fields now conform to their controlled vocabularies
    // (entityType, relationship, orgType, etc.). Regressions should be caught
    // immediately to prevent free-text drift.
    advisory: false,
    emitOutputInCi: true,
  },
  {
    id: 'resource-refs',
    name: 'Resource reference validation (advisory)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-resource-refs.ts'],
    cwd: PROJECT_ROOT,
    // Advisory: requires wiki-server access. Validates that authorEntityIds
    // and publicationId fields in the resources table reference valid entities
    // and publications. Informational for now.
    advisory: true,
    requiresServer: true,
    emitOutputInCi: true,
  },
  {
    id: 'resource-quality',
    name: 'Resource data quality (titles, authors, type contradictions)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-resource-quality.ts'],
    cwd: PROJECT_ROOT,
    // Advisory: errors are in PG data that require server access to fix.
    // Warnings (platform-name authors, type/subtype contradictions) are informational.
    // Gracefully skips if snapshot file is unavailable (fail-open).
    advisory: true,
  },
  {
    id: 'cross-base',
    name: 'Cross-base consistency (WikiBase/TableBase/FactBase alignment)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-cross-base.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: validates that WikiBase pages match TableBase entity declarations
    // and FactBase entities have corresponding TableBase entries. All existing
    // mismatches have been resolved — regressions should be caught immediately.
    advisory: false,
    emitOutputInCi: true,
  },
  {
    id: 'related-entry-types',
    name: 'Related entry type mismatches (relatedEntries[].type vs actual entity type)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-related-entry-types.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: a relatedEntries type mismatch means the UI may display wrong
    // type icons, filter incorrectly, or render broken type-specific components.
    // Auto-fixable with --fix.
  },
  {
    id: 'numeric-consistency',
    name: 'Cross-page numeric consistency (advisory)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-numeric-consistency.ts'],
    cwd: PROJECT_ROOT,
    // Advisory: heuristic detection with false positives. Flags potential
    // contradictions when the same entity has different numeric values
    // across pages (funding amounts, employee counts, etc.).
    advisory: true,
    emitOutputInCi: true,
  },
  {
    id: 'stale-content',
    name: 'Stale content detection (advisory)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-stale-content.ts'],
    cwd: PROJECT_ROOT,
    // Advisory: flags pages that may contain outdated information based on
    // entity departure dates, YAML modification times, and page age.
    advisory: true,
    emitOutputInCi: true,
  },
  {
    id: 'cross-page-dates',
    name: 'Cross-page date consistency (advisory)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-cross-page-dates.ts'],
    cwd: PROJECT_ROOT,
    // Advisory: detects when the same entity has different dates (founding,
    // departure, employment ranges) stated across multiple wiki pages.
    advisory: true,
    emitOutputInCi: true,
  },
  {
    id: 'display-names',
    name: 'Display name quality (no raw machine IDs in titles)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-display-names.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: raw stableIds or "Unknown" in entity titles produce broken
    // display on organization pages, people pages, and directory listings.
    // These indicate data pipeline bugs that should be caught immediately.
  },
  {
    id: 'tablebase-completeness',
    name: 'Tablebase route completeness (delete, things sync, entity ref validation)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-tablebase-completeness.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: all pre-existing violations (delete, entity-ref) are fixed.
    // New routes that add /sync without delete-batch or entity-ref validation
    // will fail this check. Add exemptions with reasons for legitimate exceptions.
  },
  {
    id: 'tablebase-registry',
    name: 'Tablebase registry ↔ route file cross-check',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-tablebase-registry.ts'],
    cwd: PROJECT_ROOT,
    // Blocking (QUA-456): catches drift between crux/tablebase/table-registry.ts
    // and the wiki-server tablebase route files. New registry entries must
    // point at real files, new routes with /sync must be registered, and
    // every syncPath/deletePath must resolve to a declared handler.
  },
  {
    id: 'display-formatting',
    name: 'Display formatting quality (no [object Object], no unescaped MDX in titles)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-display-formatting.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: [object Object] in any field and unescaped MDX characters in
    // titles indicate serialization bugs or data contamination that produce
    // broken rendering.
  },
  {
    id: 'person-refs',
    name: 'Person reference validation (FactBase person refs resolve with names)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-person-refs.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: FactBase facts that reference people via !ref must resolve to
    // entity registry entries with displayable names. Unresolved person refs
    // cause raw sid_ strings or "Unknown" to display on org pages.
  },
  {
    id: 'rendered-sid',
    name: 'Rendered SID check (no sid_ leaks in built data)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-rendered-sid.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: sid_ stableIds must never appear in display positions in
    // built data files (database.json, factbase-data.json). This is the
    // last line of defense — catches the symptom regardless of cause.
  },
  {
    id: 'aiid-no-report-text',
    name: 'AIID ingest does not persist CC-BY-SA-excluded report bodies',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-aiid-no-report-text.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: MIT AI Incident Database snapshots are CC-BY-SA 4.0 except
    // `submissions` and `reports.text`/`reports.plain_text`. This validator
    // greps the AIID ingest + schema paths for symptoms of re-introducing
    // those fields. QUA-693.
  },
  {
    id: 'oecd-aim-no-article-body',
    name: 'OECD AIM ingest does not persist article body text',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-oecd-aim-no-article-body.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: OECD AIM has no explicit open-data license at oecd.ai. We
    // mirror metadata + link-out only. This validator greps the OECD AIM
    // ingest + schema paths for symptoms of persisting `body`/`thumbImage`.
    // QUA-696.
  },
  {
    id: 'ai-incidents-source-enum',
    name: 'ai_incidents.source enum lockstep (route VALID_SOURCES <-> CHECK constraint)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-ai-incidents-source-enum.ts'],
    cwd: PROJECT_ROOT,
    // Blocking: prevents widening VALID_SOURCES in the route without a
    // paired migration that widens chk_ai_incidents_source (or vice versa).
    // QUA-696.
  },
  {
    id: 'benchmark-result-provenance',
    name: 'Benchmark result provenance (tested_by + source_url)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-benchmark-result-provenance.ts'],
    cwd: PROJECT_ROOT,
    // Advisory until Phase 2 ingesters have populated tested_by + source_url
    // for the bulk of rows (target: one week clean before promoting to
    // blocking). Surfaces verifiability gaps without wedging current PRs.
    advisory: true,
    requiresServer: true,
    emitOutputInCi: true,
  },
];

// Phase 4 (--full only): Runs after all validations pass
const BUILD_STEP: Step = {
  id: 'build',
  name: 'Full Next.js build',
  command: 'pnpm',
  args: ['build'],
  cwd: APP_DIR,
};

interface StepResult {
  id: string;
  name: string;
  passed: boolean;
  duration: number;
  exitCode: number | null;
  advisory?: boolean;
  emitOutputInCi?: boolean;
  capturedOutput: string;
}

/**
 * Run a single step.
 * When buffer=true (parallel mode), output is always captured and never streamed.
 * When buffer=false (sequential mode), output is streamed live in non-CI mode.
 */
function runStep(step: Step, buffer = false): Promise<StepResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(step.command, step.args, {
      cwd: step.cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let capturedOutput = '';

    child.stdout!.on('data', (data: Buffer) => {
      if (!CI_MODE && !buffer) {
        process.stdout.write(data);
      } else {
        capturedOutput += data.toString();
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      if (!CI_MODE && !buffer) {
        process.stderr.write(data);
      } else {
        capturedOutput += data.toString();
      }
    });

    child.on('close', (code: number | null) => {
      // In CI mode, dump captured output when a step fails so errors are
      // visible in workflow logs (otherwise they're silently discarded).
      // Also emit for advisory steps with emitOutputInCi=true so findings
      // are visible even when the step exits 0.
      if (CI_MODE && (code !== 0 || step.emitOutputInCi) && capturedOutput) {
        process.stdout.write(capturedOutput);
      }
      resolve({
        id: step.id,
        name: step.name,
        passed: code === 0,
        duration: Date.now() - start,
        exitCode: code,
        capturedOutput,
        advisory: step.advisory,
        emitOutputInCi: step.emitOutputInCi,
      });
    });

    child.on('error', (err: Error) => {
      const errMsg = `Error spawning ${step.command}: ${err.message}\n`;
      if (!CI_MODE && !buffer) {
        process.stderr.write(errMsg);
      } else {
        capturedOutput += errMsg;
      }
      resolve({
        id: step.id,
        name: step.name,
        passed: false,
        duration: Date.now() - start,
        exitCode: 1,
        capturedOutput,
        advisory: step.advisory,
        emitOutputInCi: step.emitOutputInCi,
      });
    });
  });
}

/** Run a single step sequentially, streaming output live, and print a pass/fail status line. */
async function runSequential(step: Step): Promise<StepResult> {
  if (!CI_MODE) {
    console.log(`${c.cyan}▶ ${step.name}${c.reset}`);
  }
  const result = await runStep(step, false);
  if (!CI_MODE) {
    if (result.passed) {
      console.log(`${c.green}✓ ${step.name}${c.reset} ${c.dim}(${formatMs(result.duration)})${c.reset}\n`);
    } else {
      console.log(`${c.red}✗ ${step.name} FAILED${c.reset} ${c.dim}(${formatMs(result.duration)})${c.reset}\n`);
    }
  }
  return result;
}

/**
 * Run multiple steps in parallel (buffering output), then print results in order.
 * All steps run to completion even if some fail — gives full error report in one pass.
 */
async function runParallel(steps: Step[]): Promise<StepResult[]> {
  if (!CI_MODE) {
    const names = steps.map(s => s.name).join(', ');
    console.log(`${c.cyan}▶ Running in parallel: ${names}${c.reset}\n`);
  }

  const results = await Promise.all(steps.map(s => runStep(s, true)));

  // Print buffered output in deterministic (step definition) order
  for (const result of results) {
    if (!CI_MODE) {
      if (result.passed) {
        console.log(`${c.green}✓ ${result.name}${c.reset} ${c.dim}(${formatMs(result.duration)})${c.reset}`);
      } else {
        console.log(`${c.red}✗ ${result.name} FAILED${c.reset} ${c.dim}(${formatMs(result.duration)})${c.reset}`);
      }
      if (result.capturedOutput.trim()) {
        process.stdout.write(result.capturedOutput);
      }
      console.log();
    } else if ((!result.passed || result.emitOutputInCi) && result.capturedOutput) {
      process.stdout.write(result.capturedOutput);
    }
  }

  return results;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const totalStart = Date.now();
  const allResults: StepResult[] = [];
  let triageResult: TriageResult | null = null;
  let skippedBuildData = false;

  // ── Stamp cache check — skip gate if HEAD unchanged since last pass ────────
  if (!NO_CACHE) {
    const headHash = getHeadHash();
    const stamp = readStamp();
    if (headHash && stamp && stamp.hash === headHash) {
      // A "full" stamp satisfies both full and fast requests.
      // A "fast" stamp only satisfies fast requests.
      const modeOk = stamp.mode === 'full' || !FULL_MODE;
      if (modeOk) {
        if (!CI_MODE) {
          console.log(`\n${c.green}${c.bold}  ✅ Gate already passed for this commit${c.reset} ${c.dim}(${headHash.slice(0, 8)}, ${stamp.mode} mode)${c.reset}`);
          console.log(`${c.dim}  Skipping re-run. Use --no-cache to force.${c.reset}\n`);
        }
        return;
      }
    }
  }

  // ── Content-only scope — skip build pipeline, run only content validations ──
  if (CONTENT_ONLY) {
    if (!CI_MODE) {
      console.log(`\n${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
      console.log(`${c.bold}${c.blue}  Gate Check (content-only scope)${c.reset}`);
      console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
      console.log(`${c.dim}  Skipping build-data, tests, typechecks — content validation only${c.reset}\n`);
    }

    // Phase 2: Auto-fix (if requested)
    if (FIX_MODE) {
      for (const step of FIX_STEPS) {
        const result = await runSequential(step);
        allResults.push(result);
        if (!result.passed) {
          printSummary(allResults, totalStart);
          process.exitCode = 1;
          return;
        }
      }
    }

    // Phase 3 (subset): Only content-relevant checks
    // temporal-invariants inspects only YAML/data files, so it belongs here
    const contentSteps = PARALLEL_STEPS.filter(s =>
      s.id === 'unified-blocking' || s.id === 'yaml-schema' || s.id === 'temporal-invariants'
    );
    const contentResults = await runParallel(contentSteps);
    allResults.push(...contentResults);

    printSummary(allResults, totalStart);

    if (contentResults.some(r => !r.passed && !r.advisory)) {
      process.exitCode = 1;
    }
    // Do NOT write stamp cache for content-only runs
    return;
  }

  // ── Pre-triage: Check wiki-server availability for server-dependent checks ──
  const hasServerDependentSteps = PARALLEL_STEPS.some(s => s.requiresServer);
  let serverAvailable = true;
  if (hasServerDependentSteps && !CI_MODE) {
    // In CI, the wiki-server is always expected to be available.
    // Locally, check and skip server-dependent checks if unreachable.
    try {
      serverAvailable = await isServerAvailable();
    } catch {
      serverAvailable = false;
    }
    if (!serverAvailable && !CI_MODE) {
      const serverSteps = PARALLEL_STEPS.filter(s => s.requiresServer);
      console.log(`${c.dim}  Wiki-server unreachable — ${serverSteps.length} server-dependent check(s) will be skipped${c.reset}`);
    }
  }

  // ── Phase 0: Triage — decide which checks to skip ─────────────────────────
  if (!NO_TRIAGE && changedFiles.length > 0) {
    const categories = categorizeFiles(changedFiles);

    // Deterministic: skip build-data if only crux/wiki-server changes
    if (canSkipBuildData(categories)) {
      skippedBuildData = true;
    }

    // LLM triage: ask Haiku which parallel checks to skip
    const allStepIds = PARALLEL_STEPS.map(s => s.id);
    triageResult = await triageGateChecks(changedFiles, allStepIds, categories);
  }

  // Filter parallel steps based on triage + server availability
  const skippedStepIds = new Set(triageResult ? Object.keys(triageResult.skip) : []);
  const activeParallelSteps = PARALLEL_STEPS.filter(s => {
    if (skippedStepIds.has(s.id)) return false;
    // Skip server-dependent checks when wiki-server is unreachable (local only)
    if (s.requiresServer && !serverAvailable && !CI_MODE) return false;
    return true;
  });
  const skippedCount = PARALLEL_STEPS.length - activeParallelSteps.length + (skippedBuildData ? 1 : 0);

  const totalSteps = (skippedBuildData ? 0 : 1) + (FIX_MODE ? FIX_STEPS.length : 0) + activeParallelSteps.length + (FULL_MODE ? 1 : 0);

  if (!CI_MODE) {
    const mode = FULL_MODE ? 'full' : 'fast';
    console.log(`\n${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`${c.bold}${c.blue}  Gate Check (${mode})${c.reset}`);
    console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
    if (AUTO_FULL) {
      console.log(`${c.dim}  Auto-escalated to full build (app pages or data files changed)${c.reset}`);
    }
    if (skippedCount > 0) {
      console.log(`${c.dim}  Triage: ${skippedCount} check${skippedCount > 1 ? 's' : ''} skipped based on diff analysis${c.reset}`);
      if (skippedBuildData) {
        console.log(`${c.dim}    - build-data: no MDX/YAML/app changes, database.json exists${c.reset}`);
      }
      if (triageResult) {
        for (const [id, reason] of Object.entries(triageResult.skip)) {
          console.log(`${c.dim}    - ${id}: ${reason}${c.reset}`);
        }
        if (triageResult.llmCalled) {
          console.log(`${c.dim}    (Haiku triage in ${triageResult.durationMs}ms)${c.reset}`);
        }
      }
    }
    console.log(`${c.dim}  Running ${totalSteps} CI-blocking checks (${activeParallelSteps.length} in parallel)...${c.reset}\n`);
  }

  // ── Phase 0.5: Assign IDs from server (advisory — doesn't block) ───────────
  if (skippedBuildData) {
    if (!CI_MODE) {
      console.log(`${c.dim}⊘ Assign entity IDs (skipped — no data changes)${c.reset}`);
    }
  } else {
    const assignIdsResult = await runSequential(ASSIGN_IDS_STEP);
    allResults.push(assignIdsResult);
    // Advisory: log failure but don't exit — build-data has its own fallback
    if (!assignIdsResult.passed && !CI_MODE) {
      console.log(`${c.yellow}  ⚠ ID assignment failed (server may be unavailable) — build-data will use fallback${c.reset}\n`);
    }
  }

  // ── Phase 1: Build data (prerequisite for everything) ──────────────────────
  if (skippedBuildData) {
    if (!CI_MODE) {
      console.log(`${c.dim}⊘ Build data layer (skipped — no data changes)${c.reset}\n`);
    }
  } else {
    const buildDataResult = await runSequential(BUILD_DATA_STEP);
    allResults.push(buildDataResult);
    if (!buildDataResult.passed) {
      printSummary(allResults, totalStart, skippedCount);
      process.exitCode = 1;
      return;
    }
  }

  // ── Phase 2: Auto-fix (sequential, must run before validation) ─────────────
  if (FIX_MODE) {
    for (const step of FIX_STEPS) {
      const result = await runSequential(step);
      allResults.push(result);
      if (!result.passed) {
        printSummary(allResults, totalStart, skippedCount);
        process.exitCode = 1;
        return;
      }
    }
  }

  // ── Phase 3: Independent checks in parallel ────────────────────────────────
  const parallelResults = await runParallel(activeParallelSteps);
  allResults.push(...parallelResults);
  if (parallelResults.some(r => !r.passed && !r.advisory)) {
    printSummary(allResults, totalStart, skippedCount);
    process.exitCode = 1;
    return;
  }

  // ── Phase 4: Full Next.js build (only if all other checks pass) ────────────
  if (FULL_MODE) {
    const buildResult = await runSequential(BUILD_STEP);
    allResults.push(buildResult);
    if (!buildResult.passed) {
      printSummary(allResults, totalStart, skippedCount);
      process.exitCode = 1;
      return;
    }
  }

  printSummary(allResults, totalStart, skippedCount);

  // Write stamp so subsequent pushes of the same commit skip the gate
  const headHash = getHeadHash();
  if (headHash) {
    writeStamp(headHash, FULL_MODE ? 'full' : 'fast');
  }

}

function printSummary(results: StepResult[], totalStart: number, skippedCount: number = 0): void {
  const totalDuration = Date.now() - totalStart;
  const blockingFailed = results.filter((r) => !r.passed && !r.advisory);
  const advisoryFailed = results.filter((r) => !r.passed && r.advisory);
  const passed = blockingFailed.length === 0;
  const failed = blockingFailed;

  if (CI_MODE) {
    console.log(JSON.stringify({ passed, skippedCount, results: results.map(r => ({ id: r.id, name: r.name, passed: r.passed, duration: r.duration, exitCode: r.exitCode })), duration: formatMs(totalDuration) }));
  } else {
    console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    if (passed) {
      const skippedNote = skippedCount > 0 ? `, ${skippedCount} skipped by triage` : '';
      const advisoryNote = advisoryFailed.length > 0
        ? ` ${c.dim}(${advisoryFailed.length} advisory warning${advisoryFailed.length > 1 ? 's' : ''}${skippedNote})${c.reset}`
        : (skippedNote ? ` ${c.dim}(${skippedNote.slice(2)})${c.reset}` : '');
      console.log(`${c.green}${c.bold}  ✅ All ${results.length} gate checks passed${c.reset} ${c.dim}(${formatMs(totalDuration)})${c.reset}${advisoryNote}`);
      for (const f of advisoryFailed) {
        console.log(`${c.yellow}  ⚠ ${f.name}${c.reset}`);
      }
    } else {
      console.log(`${c.red}${c.bold}  ❌ Gate check failed${c.reset} ${c.dim}(${formatMs(totalDuration)})${c.reset}`);
      for (const f of failed) {
        console.log(`${c.red}  • ${f.name}${c.reset}`);
      }
    }
    console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});