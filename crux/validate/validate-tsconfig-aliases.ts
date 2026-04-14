#!/usr/bin/env node

/**
 * Validate that @wiki-server/* path aliases stay in sync between
 * crux/tsconfig.json and apps/web/tsconfig.json.
 *
 * Checks two axes of drift:
 *   1. Key parity — both configs must declare the same @wiki-server/*
 *      alias keys.
 *   2. Target parity — for each shared key, the target path in each
 *      config must resolve (relative to that config's baseUrl) to the
 *      same absolute file. Target-path drift is the more common and
 *      more insidious failure mode: the keys still match so naive
 *      key-set checks pass, but one side points at a stale or wrong
 *      file and the crux tsc check emits fake "Cannot find module"
 *      errors that silently inflate the crux-tsc-baseline.
 *
 * Neither config currently uses `extends`. The validator fails loudly
 * if one ever gains an `extends` clause, because resolving extends is
 * out of scope and silently ignoring it would mask real drift.
 *
 * See QUA-483.
 *
 * Usage: npx tsx crux/validate/validate-tsconfig-aliases.ts
 */

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const ALIAS_PREFIX = '@wiki-server/';

export interface TsConfigEntry {
  label: string;
  path: string;
}

const DEFAULT_TSCONFIGS: readonly TsConfigEntry[] = [
  { label: 'crux/tsconfig.json', path: join(PROJECT_ROOT, 'crux/tsconfig.json') },
  { label: 'apps/web/tsconfig.json', path: join(PROJECT_ROOT, 'apps/web/tsconfig.json') },
] as const;

interface TsConfig {
  extends?: string;
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

function readTsConfig(entry: TsConfigEntry): TsConfig {
  let raw: string;
  try {
    raw = readFileSync(entry.path, 'utf-8');
  } catch (e) {
    throw new Error(
      `Could not read ${entry.label} at ${entry.path}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  try {
    return JSON.parse(raw) as TsConfig;
  } catch (e) {
    throw new Error(
      `Could not parse ${entry.label} as JSON: ${e instanceof Error ? e.message : String(e)}. ` +
        `(Note: this validator does not support JSONC comments — strip them or upgrade the parser.)`
    );
  }
}

function extractWikiServerPaths(cfg: TsConfig): Record<string, string[]> {
  const paths = cfg.compilerOptions?.paths ?? {};
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(paths)) {
    if (key.startsWith(ALIAS_PREFIX)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Resolve a tsconfig alias target pattern to an absolute file path.
 *
 * Rules:
 *   - baseUrl defaults to "." (the tsconfig's own directory) if unset
 *   - pattern is resolved relative to baseUrl
 *   - the result is an absolute, normalized path
 */
export function resolveAliasTarget(tsconfigPath: string, baseUrl: string, pattern: string): string {
  const tsconfigDir = dirname(tsconfigPath);
  const base = resolve(tsconfigDir, baseUrl);
  return resolve(base, pattern);
}

export interface AliasDrift {
  onlyInFirst: string[];
  onlyInSecond: string[];
  /** Keys present in both configs but resolving to different absolute paths. */
  targetMismatches: Array<{
    key: string;
    first: string[];
    second: string[];
  }>;
}

export function diffAliases(
  first: Record<string, string[]>,
  firstTsconfigPath: string,
  firstBaseUrl: string,
  second: Record<string, string[]>,
  secondTsconfigPath: string,
  secondBaseUrl: string
): AliasDrift {
  const firstKeys = new Set(Object.keys(first));
  const secondKeys = new Set(Object.keys(second));

  const onlyInFirst = [...firstKeys].filter((k) => !secondKeys.has(k)).sort();
  const onlyInSecond = [...secondKeys].filter((k) => !firstKeys.has(k)).sort();

  const sharedKeys = [...firstKeys].filter((k) => secondKeys.has(k)).sort();
  const targetMismatches: AliasDrift['targetMismatches'] = [];
  for (const key of sharedKeys) {
    const firstAbs = (first[key] ?? []).map((p) =>
      resolveAliasTarget(firstTsconfigPath, firstBaseUrl, p)
    );
    const secondAbs = (second[key] ?? []).map((p) =>
      resolveAliasTarget(secondTsconfigPath, secondBaseUrl, p)
    );
    if (firstAbs.length !== secondAbs.length || firstAbs.some((p, i) => p !== secondAbs[i])) {
      targetMismatches.push({ key, first: firstAbs, second: secondAbs });
    }
  }

  return { onlyInFirst, onlyInSecond, targetMismatches };
}

export interface RunCheckOptions {
  /** Override the default [crux, apps/web] tsconfig pair (used by tests). */
  tsconfigs?: readonly TsConfigEntry[];
  /** Suppress the success banner (used by tests). */
  silent?: boolean;
}

export interface RunCheckResult {
  passed: boolean;
  errors: number;
  drift: AliasDrift;
}

export function runCheck(options: RunCheckOptions = {}): RunCheckResult {
  const c = getColors();
  const silent = options.silent ?? false;
  const tsconfigs = options.tsconfigs ?? DEFAULT_TSCONFIGS;

  if (tsconfigs.length !== 2) {
    throw new Error(
      `validate-tsconfig-aliases expects exactly 2 tsconfigs, got ${tsconfigs.length}`
    );
  }
  const [firstEntry, secondEntry] = tsconfigs;

  if (!silent) {
    console.log(`${c.blue}Checking @wiki-server/* alias parity between tsconfigs...${c.reset}\n`);
  }

  const firstCfg = readTsConfig(firstEntry);
  const secondCfg = readTsConfig(secondEntry);

  // Refuse to run on configs that use `extends` — resolving the chain is
  // out of scope and silently dropping inherited paths would mask drift.
  for (const [entry, cfg] of [
    [firstEntry, firstCfg],
    [secondEntry, secondCfg],
  ] as const) {
    if (cfg.extends !== undefined) {
      console.error(
        `${c.red}${entry.label} uses "extends": "${cfg.extends}" — this validator does not support extends chains.${c.reset}`
      );
      console.error(
        `${c.dim}Either resolve the chain manually or extend this validator to follow extends.${c.reset}`
      );
      return { passed: false, errors: 1, drift: { onlyInFirst: [], onlyInSecond: [], targetMismatches: [] } };
    }
  }

  const firstBaseUrl = firstCfg.compilerOptions?.baseUrl ?? '.';
  const secondBaseUrl = secondCfg.compilerOptions?.baseUrl ?? '.';

  const firstPaths = extractWikiServerPaths(firstCfg);
  const secondPaths = extractWikiServerPaths(secondCfg);

  const drift = diffAliases(
    firstPaths,
    firstEntry.path,
    firstBaseUrl,
    secondPaths,
    secondEntry.path,
    secondBaseUrl
  );

  const totalErrors =
    drift.onlyInFirst.length + drift.onlyInSecond.length + drift.targetMismatches.length;

  if (totalErrors === 0) {
    if (!silent) {
      console.log(
        `${c.green}✓ @wiki-server/* aliases in sync (${Object.keys(firstPaths).length} keys)${c.reset}`
      );
    }
    return { passed: true, errors: 0, drift };
  }

  console.error(
    `${c.red}Found ${totalErrors} @wiki-server/* alias drift(s) between ${firstEntry.label} and ${secondEntry.label}:${c.reset}\n`
  );
  if (drift.onlyInSecond.length > 0) {
    console.error(`  ${c.yellow}Missing from ${firstEntry.label}:${c.reset}`);
    for (const key of drift.onlyInSecond) console.error(`    - ${key}`);
    console.error();
  }
  if (drift.onlyInFirst.length > 0) {
    console.error(`  ${c.yellow}Missing from ${secondEntry.label}:${c.reset}`);
    for (const key of drift.onlyInFirst) console.error(`    - ${key}`);
    console.error();
  }
  if (drift.targetMismatches.length > 0) {
    console.error(
      `  ${c.yellow}Target-path mismatches (keys present in both but resolve to different files):${c.reset}`
    );
    for (const mismatch of drift.targetMismatches) {
      console.error(`    ${mismatch.key}`);
      console.error(`      ${firstEntry.label}:  ${mismatch.first.join(', ')}`);
      console.error(`      ${secondEntry.label}: ${mismatch.second.join(', ')}`);
    }
    console.error();
  }
  console.error(
    `${c.dim}Fix: align the @wiki-server/* entries so both files have the same keys and each key's target resolves to the same absolute file.${c.reset}`
  );
  console.error(
    `${c.dim}Context: QUA-483 — drift causes fake "Cannot find module" errors in the crux tsc check.${c.reset}`
  );

  return { passed: false, errors: totalErrors, drift };
}

if (process.argv[1]?.includes('validate-tsconfig-aliases')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
