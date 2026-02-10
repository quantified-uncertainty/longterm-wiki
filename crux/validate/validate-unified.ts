#!/usr/bin/env node

/**
 * Unified Validation Runner
 *
 * A single-pass validation system that loads content once and runs multiple
 * validation rules efficiently. This is the recommended way to run validations.
 *
 * Usage:
 *   npx tsx crux/validate/validate-unified.ts              # Run all rules
 *   npx tsx crux/validate/validate-unified.ts --rules=entitylink-ids,jsx-in-md
 *   npx tsx crux/validate/validate-unified.ts --ci         # JSON output
 *   npx tsx crux/validate/validate-unified.ts --list       # List available rules
 *   npx tsx crux/validate/validate-unified.ts --errors-only # Only show errors
 *   npx tsx crux/validate/validate-unified.ts --fix        # Auto-fix fixable issues
 *   npx tsx crux/validate/validate-unified.ts --fixable    # Only show fixable issues
 *
 * Exit codes:
 *   0 = No errors (warnings don't fail by default)
 *   1 = One or more errors found
 */

import { fileURLToPath } from 'url';
import { ValidationEngine, Severity, type Issue } from '../lib/validation-engine.ts';
import { allRules } from '../lib/rules/index.ts';
import { getColors } from '../lib/output.ts';

interface ParsedArgs {
  ci: boolean;
  list: boolean;
  errorsOnly: boolean;
  verbose: boolean;
  fix: boolean;
  fixableOnly: boolean;
  selectedRules: string[] | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const rulesArg = args.find((a: string) => a.startsWith('--rules='));
  return {
    ci: args.includes('--ci'),
    list: args.includes('--list'),
    errorsOnly: args.includes('--errors-only'),
    verbose: args.includes('--verbose') || args.includes('-v'),
    fix: args.includes('--fix'),
    fixableOnly: args.includes('--fixable'),
    selectedRules: rulesArg ? rulesArg.replace('--rules=', '').split(',') : null,
  };
}

const parsedArgs: ParsedArgs = parseArgs(process.argv);
const colors = getColors(parsedArgs.ci);

async function main(): Promise<void> {
  // List mode
  if (parsedArgs.list) {
    console.log(`${colors.bold}Available validation rules:${colors.reset}\n`);
    for (const rule of allRules) {
      console.log(`  ${colors.cyan}${rule.id}${colors.reset}`);
      console.log(`    ${colors.dim}${rule.description}${colors.reset}`);
      console.log(`    Scope: ${rule.scope || 'file'}\n`);
    }
    process.exit(0);
  }

  const startTime: number = Date.now();

  // Create engine and register rules
  const engine = new ValidationEngine();

  if (!parsedArgs.ci) {
    console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}  Unified Content Validation${colors.reset}`);
    console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  }

  // Register rules
  for (const rule of allRules) {
    if (!parsedArgs.selectedRules || parsedArgs.selectedRules.includes(rule.id)) {
      engine.addRule(rule);
    }
  }

  if (!parsedArgs.ci) {
    console.log(`${colors.dim}Loading content...${colors.reset}`);
  }

  // Load content
  await engine.load();

  if (!parsedArgs.ci) {
    console.log(`${colors.dim}Loaded ${engine.content.size} files${colors.reset}`);
    console.log(`${colors.dim}Running ${engine.rules.size} rules...${colors.reset}\n`);
  }

  // Run validation
  let issues: Issue[] = await engine.validate({
    ruleIds: parsedArgs.selectedRules,
  });

  // Filter if errors only
  if (parsedArgs.errorsOnly) {
    issues = issues.filter((i: Issue) => i.severity === Severity.ERROR);
  }

  // Filter to fixable only if requested
  if (parsedArgs.fixableOnly) {
    issues = issues.filter((i: Issue) => i.isFixable);
  }

  // Fix mode: apply fixes and exit
  if (parsedArgs.fix) {
    const fixableIssues: Issue[] = issues.filter((i: Issue) => i.isFixable);
    const unfixableIssues: Issue[] = issues.filter((i: Issue) => !i.isFixable);

    if (fixableIssues.length === 0) {
      console.log(`${colors.green}✓ No fixable issues found${colors.reset}`);
      process.exit(0);
    }

    const { filesFixed, issuesFixed } = engine.applyFixes(fixableIssues);
    console.log(`${colors.green}✓ Fixed ${issuesFixed} issues in ${filesFixed} files${colors.reset}`);

    if (unfixableIssues.length > 0) {
      console.log(`${colors.yellow}⚠ ${unfixableIssues.length} issues require manual fixes${colors.reset}`);
    }

    process.exit(0);
  }

  // Output results
  if (parsedArgs.ci) {
    console.log(engine.formatOutput(issues, { ci: true }));
  } else {
    if (issues.length > 0) {
      console.log(engine.formatOutput(issues, { verbose: parsedArgs.verbose }));
    }

    const summary = engine.getSummary(issues);
    const fixableSummary: number = issues.filter((i: Issue) => i.isFixable).length;
    const duration: string = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

    if (summary.hasErrors) {
      console.log(`${colors.red}${colors.bold}❌ Validation failed with ${summary.bySeverity.error} error(s)${colors.reset}`);
      if (fixableSummary > 0) {
        console.log(`${colors.dim}  ${fixableSummary} can be auto-fixed with --fix${colors.reset}`);
      }
    } else if (summary.bySeverity.warning > 0) {
      console.log(`${colors.yellow}${colors.bold}⚠️  Validation passed with ${summary.bySeverity.warning} warning(s)${colors.reset}`);
    } else {
      console.log(`${colors.green}${colors.bold}✅ All checks passed!${colors.reset}`);
    }

    console.log(`${colors.dim}Duration: ${duration}s${colors.reset}\n`);

    // Show breakdown by rule
    if (issues.length > 0 && parsedArgs.verbose) {
      console.log(`${colors.bold}Issues by rule:${colors.reset}`);
      for (const [rule, count] of Object.entries(summary.byRule)) {
        console.log(`  ${rule}: ${count}`);
      }
      console.log();
    }
  }

  // Exit with error if there were errors
  const summary = engine.getSummary(issues);
  process.exit(summary.hasErrors ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error('Validation failed:', err);
    process.exit(1);
  });
}
