#!/usr/bin/env node

/**
 * Convert crux unified validation JSON output to Reviewdog's rdjsonl format.
 *
 * Reads the JSON output of `pnpm crux validate unified --ci` from stdin
 * and writes rdjsonl (one JSON object per line) to stdout.
 *
 * Usage:
 *   pnpm crux validate unified --ci | npx tsx crux/validate/to-rdjsonl.ts
 *
 * rdjsonl spec: https://github.com/reviewdog/reviewdog/tree/master/proto/rdf
 */

import { relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';

interface CruxIssue {
  rule: string;
  file: string;
  line?: number;
  message: string;
  severity: string;
}

interface CruxOutput {
  issues: CruxIssue[];
  summary: {
    total: number;
    byRule: Record<string, number>;
    bySeverity: { error: number; warning: number; info: number };
    hasErrors: boolean;
  };
}

interface RdjsonlDiagnostic {
  message: string;
  location: {
    path: string;
    range?: {
      start: { line: number };
    };
  };
  severity: 'ERROR' | 'WARNING' | 'INFO';
  code?: {
    value: string;
  };
  source: {
    name: string;
  };
}

function severityToRd(severity: string): 'ERROR' | 'WARNING' | 'INFO' {
  switch (severity) {
    case 'error':
      return 'ERROR';
    case 'warning':
      return 'WARNING';
    default:
      return 'INFO';
  }
}

function toRelativePath(absolutePath: string): string {
  if (absolutePath.startsWith('/')) {
    return relative(PROJECT_ROOT, absolutePath);
  }
  return absolutePath;
}

function convertIssue(issue: CruxIssue): RdjsonlDiagnostic {
  const diagnostic: RdjsonlDiagnostic = {
    message: issue.message,
    location: {
      path: toRelativePath(issue.file),
    },
    severity: severityToRd(issue.severity),
    code: {
      value: issue.rule,
    },
    source: {
      name: 'crux-validate',
    },
  };

  if (issue.line) {
    diagnostic.location.range = {
      start: { line: issue.line },
    };
  }

  return diagnostic;
}

async function main(): Promise<void> {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = Buffer.concat(chunks).toString('utf-8').trim();

  if (!input) {
    // No input — nothing to convert
    process.exit(0);
  }

  let data: CruxOutput;
  try {
    data = JSON.parse(input) as CruxOutput;
  } catch (e) {
    console.error(`Failed to parse JSON input: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (!data.issues || !Array.isArray(data.issues)) {
    console.error('Input JSON missing "issues" array');
    process.exit(1);
  }

  // Output one rdjsonl diagnostic per line
  for (const issue of data.issues) {
    const diagnostic = convertIssue(issue);
    console.log(JSON.stringify(diagnostic));
  }
}

main().catch((err: unknown) => {
  console.error(`to-rdjsonl failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
