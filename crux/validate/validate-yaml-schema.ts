#!/usr/bin/env npx tsx

/**
 * YAML Schema Validation Script
 *
 * Validates YAML data files against Zod schemas from src/data/schema.ts.
 * Ensures entity, resource, and publication data conforms to expected structure.
 *
 * Usage: npx tsx scripts/validate-yaml-schema.ts [--ci]
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'url';
import { getColors, isCI, formatPath } from '../lib/output.ts';
import { Entity, Resource, Publication, Intervention, Proposal, FactsFile, FactMetricsFile } from '../../data/schema.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';
import type { ZodSchema, ZodError, ZodIssue } from 'zod';
import type { Colors } from '../lib/output.ts';

const DATA_DIR = 'data';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface YamlItemWithSource {
  _sourceFile?: string;
  id?: string;
  title?: string;
  [key: string]: unknown;
}

interface SchemaError {
  file: string;
  id: string;
  type: string;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load and parse a YAML file
 */
function loadYaml(filepath: string): unknown[] | null {
  if (!existsSync(filepath)) {
    return null;
  }
  const content = readFileSync(filepath, 'utf-8');
  return parseYaml(content);
}

/**
 * Load all YAML files from a directory and merge arrays
 */
function loadYamlDir(dirname: string): YamlItemWithSource[] {
  const dirpath = join(DATA_DIR, dirname);
  if (!existsSync(dirpath)) {
    return [];
  }

  const files = readdirSync(dirpath).filter((f: string) => f.endsWith('.yaml'));
  const results: YamlItemWithSource[] = [];

  for (const file of files) {
    const filepath = join(dirpath, file);
    const data = loadYaml(filepath);
    if (Array.isArray(data)) {
      // Tag each item with source file
      for (const item of data) {
        item._sourceFile = filepath;
      }
      results.push(...data);
    }
  }

  return results;
}

/**
 * Format Zod errors into readable messages
 */
function formatZodErrors(error: ZodError): string[] {
  return error.issues.map((issue: ZodIssue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/**
 * Validate an array of items against a Zod schema
 */
function validateItems(items: YamlItemWithSource[], schema: ZodSchema, typeName: string): SchemaError[] {
  const errors: SchemaError[] = [];

  for (const item of items) {
    const sourceFile = item._sourceFile;
    // Remove internal field before validation
    const { _sourceFile, ...cleanItem } = item;

    const result = schema.safeParse(cleanItem);
    if (!result.success) {
      const itemId = cleanItem.id || cleanItem.title || '(unknown)';
      errors.push({
        file: sourceFile || '(unknown file)',
        id: String(itemId),
        type: typeName,
        issues: formatZodErrors(result.error),
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// runCheck (for orchestrator)
// ---------------------------------------------------------------------------

export function runCheck(options: ValidatorOptions = {}): ValidatorResult {
  const ciMode = options.ci ?? false;
  const colors: Colors = getColors(ciMode);

  const allErrors: SchemaError[] = [];
  let totalValidated = 0;

  // 1. Validate entities/*.yaml against Entity schema
  if (!ciMode) console.log(`${colors.dim}Checking entities...${colors.reset}`);
  const entities = loadYamlDir('entities');
  totalValidated += entities.length;
  const entityErrors = validateItems(entities, Entity, 'Entity');
  allErrors.push(...entityErrors);
  if (!ciMode) console.log(`  ${entities.length} entities loaded`);

  // 2. Validate resources/*.yaml against Resource schema
  if (!ciMode) console.log(`${colors.dim}Checking resources...${colors.reset}`);
  const resources = loadYamlDir('resources');
  totalValidated += resources.length;
  const resourceErrors = validateItems(resources, Resource, 'Resource');
  allErrors.push(...resourceErrors);
  if (!ciMode) console.log(`  ${resources.length} resources loaded`);

  // 3. Validate publications.yaml against Publication schema
  if (!ciMode) console.log(`${colors.dim}Checking publications...${colors.reset}`);
  const pubPath = join(DATA_DIR, 'publications.yaml');
  const publications: YamlItemWithSource[] = (loadYaml(pubPath) as YamlItemWithSource[] | null) || [];
  // Tag with source file
  for (const pub of publications) {
    pub._sourceFile = pubPath;
  }
  totalValidated += publications.length;
  const pubErrors = validateItems(publications, Publication, 'Publication');
  allErrors.push(...pubErrors);
  if (!ciMode) console.log(`  ${publications.length} publications loaded`);

  // 4. Validate interventions.yaml against Intervention schema
  if (!ciMode) console.log(`${colors.dim}Checking interventions...${colors.reset}`);
  const intPath = join(DATA_DIR, 'interventions.yaml');
  const interventions: YamlItemWithSource[] = (loadYaml(intPath) as YamlItemWithSource[] | null) || [];
  for (const item of interventions) {
    item._sourceFile = intPath;
  }
  totalValidated += interventions.length;
  const intErrors = validateItems(interventions, Intervention, 'Intervention');
  allErrors.push(...intErrors);
  if (!ciMode) console.log(`  ${interventions.length} interventions loaded`);

  // 5. Validate proposals.yaml against Proposal schema
  if (!ciMode) console.log(`${colors.dim}Checking proposals...${colors.reset}`);
  const propPath = join(DATA_DIR, 'proposals.yaml');
  const proposals: YamlItemWithSource[] = (loadYaml(propPath) as YamlItemWithSource[] | null) || [];
  for (const item of proposals) {
    item._sourceFile = propPath;
  }
  totalValidated += proposals.length;
  const propErrors = validateItems(proposals, Proposal, 'Proposal');
  allErrors.push(...propErrors);
  if (!ciMode) console.log(`  ${proposals.length} proposals loaded`);

  // 6. Validate facts/*.yaml against FactsFile schema and check metric references
  if (!ciMode) console.log(`${colors.dim}Checking facts...${colors.reset}`);
  const factsDir = join(DATA_DIR, 'facts');
  let totalFacts = 0;
  let validMetricIds: Set<string> | null = null;

  // Load metric definitions first (for cross-reference validation)
  const metricsPath = join(DATA_DIR, 'fact-metrics.yaml');
  if (existsSync(metricsPath)) {
    const metricsContent = readFileSync(metricsPath, 'utf-8');
    const metricsParsed = parseYaml(metricsContent);
    const metricsResult = FactMetricsFile.safeParse(metricsParsed);
    if (!metricsResult.success) {
      allErrors.push({
        file: metricsPath,
        id: 'fact-metrics',
        type: 'FactMetricsFile',
        issues: formatZodErrors(metricsResult.error),
      });
    } else {
      validMetricIds = new Set(Object.keys(metricsResult.data.metrics));
      if (!ciMode) console.log(`  ${validMetricIds.size} metric definitions loaded`);
    }
    totalValidated++;
  }

  // Validate each facts file
  if (existsSync(factsDir)) {
    const factFiles = readdirSync(factsDir).filter(f => f.endsWith('.yaml'));
    for (const file of factFiles) {
      const filepath = join(factsDir, file);
      const content = readFileSync(filepath, 'utf-8');
      const parsed = parseYaml(content);
      totalValidated++;

      const result = FactsFile.safeParse(parsed);
      if (!result.success) {
        allErrors.push({
          file: filepath,
          id: basename(file, '.yaml'),
          type: 'FactsFile',
          issues: formatZodErrors(result.error),
        });
      } else {
        totalFacts += Object.keys(result.data.facts).length;
        // Cross-reference: check that metric values point to valid metric IDs
        if (validMetricIds) {
          for (const [factId, fact] of Object.entries(result.data.facts)) {
            if (fact.metric && !validMetricIds.has(fact.metric)) {
              allErrors.push({
                file: filepath,
                id: `${result.data.entity}.${factId}`,
                type: 'Fact',
                issues: [`Unknown metric "${fact.metric}" — not defined in data/fact-metrics.yaml`],
              });
            }
          }
        }
      }
    }
  }
  if (!ciMode) console.log(`  ${totalFacts} facts across ${existsSync(factsDir) ? readdirSync(factsDir).filter(f => f.endsWith('.yaml')).length : 0} files`);

  // Output Results
  console.log();
  if (ciMode) {
    console.log(JSON.stringify({
      validated: totalValidated,
      errors: allErrors.length,
      details: allErrors,
    }, null, 2));
  } else {
    if (allErrors.length === 0) {
      console.log(`${colors.green}✓ All ${totalValidated} items pass schema validation${colors.reset}\n`);
    } else {
      // Group errors by file
      const byFile: Record<string, SchemaError[]> = {};
      for (const err of allErrors) {
        const key = formatPath(err.file);
        if (!byFile[key]) byFile[key] = [];
        byFile[key].push(err);
      }

      for (const [file, errors] of Object.entries(byFile)) {
        console.log(`${colors.bold}${file}${colors.reset}`);
        for (const err of errors) {
          console.log(`  ${colors.red}✗${colors.reset} ${err.id} (${err.type})`);
          for (const issue of err.issues) {
            console.log(`    ${colors.dim}${issue}${colors.reset}`);
          }
        }
        console.log();
      }

      console.log(`${colors.red}✗ ${allErrors.length} schema error(s) in ${totalValidated} items${colors.reset}\n`);
    }
  }

  return {
    passed: allErrors.length === 0,
    errors: allErrors.length,
    warnings: 0,
  };
}

// ---------------------------------------------------------------------------
// Standalone main
// ---------------------------------------------------------------------------

function main(): void {
  const result = runCheck({ ci: isCI() });
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
