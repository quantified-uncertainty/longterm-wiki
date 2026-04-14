#!/usr/bin/env node

/**
 * Validate that @wiki-server/* path alias keys stay in sync between
 * crux/tsconfig.json and apps/web/tsconfig.json.
 *
 * Drift between these tsconfigs causes fake "Cannot find module
 * '@wiki-server/*-route'" errors in the crux tsc check (transitively,
 * via apps/web/src/lib/wiki-server.ts) and silently inflates the
 * crux-tsc-baseline, hiding real errors.
 *
 * See QUA-483.
 *
 * Usage: npx tsx crux/validate/validate-tsconfig-aliases.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const ALIAS_PREFIX = '@wiki-server/';

const TSCONFIGS = [
  { label: 'crux/tsconfig.json', path: join(PROJECT_ROOT, 'crux/tsconfig.json') },
  { label: 'apps/web/tsconfig.json', path: join(PROJECT_ROOT, 'apps/web/tsconfig.json') },
] as const;

interface TsConfig {
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
}

function readTsConfig(path: string): TsConfig {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as TsConfig;
}

function extractWikiServerKeys(cfg: TsConfig): Set<string> {
  const paths = cfg.compilerOptions?.paths ?? {};
  return new Set(Object.keys(paths).filter((k) => k.startsWith(ALIAS_PREFIX)));
}

export interface AliasDrift {
  onlyInCrux: string[];
  onlyInAppsWeb: string[];
}

export function diffAliases(cruxKeys: Set<string>, appsWebKeys: Set<string>): AliasDrift {
  const onlyInCrux = [...cruxKeys].filter((k) => !appsWebKeys.has(k)).sort();
  const onlyInAppsWeb = [...appsWebKeys].filter((k) => !cruxKeys.has(k)).sort();
  return { onlyInCrux, onlyInAppsWeb };
}

export function runCheck(): { passed: boolean; errors: number; drift: AliasDrift } {
  const c = getColors();
  console.log(`${c.blue}Checking @wiki-server/* alias parity between tsconfigs...${c.reset}\n`);

  const [cruxCfg, appsWebCfg] = TSCONFIGS.map(({ path }) => readTsConfig(path));
  const cruxKeys = extractWikiServerKeys(cruxCfg);
  const appsWebKeys = extractWikiServerKeys(appsWebCfg);

  const drift = diffAliases(cruxKeys, appsWebKeys);
  const totalErrors = drift.onlyInCrux.length + drift.onlyInAppsWeb.length;

  if (totalErrors === 0) {
    console.log(
      `${c.green}✓ @wiki-server/* aliases in sync (${cruxKeys.size} keys)${c.reset}`
    );
    return { passed: true, errors: 0, drift };
  }

  console.log(
    `${c.red}Found ${totalErrors} @wiki-server/* alias drift(s):${c.reset}\n`
  );
  if (drift.onlyInAppsWeb.length > 0) {
    console.log(`  ${c.yellow}Missing from crux/tsconfig.json:${c.reset}`);
    for (const key of drift.onlyInAppsWeb) console.log(`    - ${key}`);
    console.log();
  }
  if (drift.onlyInCrux.length > 0) {
    console.log(`  ${c.yellow}Missing from apps/web/tsconfig.json:${c.reset}`);
    for (const key of drift.onlyInCrux) console.log(`    - ${key}`);
    console.log();
  }
  console.log(
    `${c.dim}Fix: copy the missing alias entries between the two files so both key sets match.${c.reset}`
  );
  console.log(
    `${c.dim}Context: QUA-483 — drift causes fake TS errors in the crux tsc check.${c.reset}`
  );

  return { passed: false, errors: totalErrors, drift };
}

if (process.argv[1]?.includes('validate-tsconfig-aliases')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
