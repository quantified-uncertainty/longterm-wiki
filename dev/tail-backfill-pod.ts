/**
 * Live, readable tail of the backfill-sources JSONL report from inside the
 * running worker pod (DigitalOcean DOKS).
 *
 * The worker runs the backfill as a child process and streams one JSON object
 * per record to /tmp/backfill-unmatched-*.json on the pod. Raw `tail -f` on
 * that file is an unreadable wall of wrapped JSON, so this script parses each
 * line and prints one short, coloured line per record instead.
 *
 * Usage:
 *   pnpm tsx dev/tail-backfill-pod.ts              # compact: one line per record
 *   pnpm tsx dev/tail-backfill-pod.ts --verbose    # full structured block per record
 *   pnpm tsx dev/tail-backfill-pod.ts --pod=NAME   # tail a specific worker pod
 *   pnpm tsx dev/tail-backfill-pod.ts --file=/tmp/backfill-unmatched-X.json
 *
 * Read-only: it only runs `ls`, `stat` and `tail -f` inside the pod.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const CTX = 'do-nyc1-quri';
const NS = 'longtermwiki';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

function kubectl(args: string[]): string {
  return execFileSync('kubectl', ['--context', CTX, '-n', NS, ...args], {
    encoding: 'utf-8',
  });
}

/** Worker pods that are Running, newest first by start time. */
function runningWorkerPods(): string[] {
  const out = kubectl([
    'get',
    'pods',
    '-l',
    'app=longterm-wiki-worker-worker',
    '--field-selector=status.phase=Running',
    '-o',
    'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
  ]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Newest backfill report file in a pod's /tmp, or null if none. */
function newestReport(pod: string): string | null {
  try {
    const out = kubectl([
      'exec',
      pod,
      '--',
      'sh',
      '-c',
      'ls -1t /tmp/backfill-unmatched-*.json 2>/dev/null | head -n1',
    ]).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Pick the pod+file whose report was modified most recently. */
function discover(): { pod: string; file: string } {
  const podOverride = arg('pod');
  const fileOverride = arg('file');
  const pods = podOverride ? [podOverride] : runningWorkerPods();

  let best: { pod: string; file: string; mtime: number } | null = null;
  for (const pod of pods) {
    const file = fileOverride ?? newestReport(pod);
    if (!file) continue;
    let mtime = 0;
    try {
      mtime = Number(
        kubectl(['exec', pod, '--', 'stat', '-c', '%Y', file]).trim(),
      );
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { pod, file, mtime };
  }

  if (!best) {
    console.error(
      `${c.red}No active backfill report found on any running worker pod.${c.reset}`,
    );
    process.exit(1);
  }
  return { pod: best.pod, file: best.file };
}

const ICON: Record<string, string> = {
  matched: `${c.green}✓ matched${c.reset}`,
  applied: `${c.green}✓ applied${c.reset}`,
  'no-match': `${c.dim}· no-match${c.reset}`,
  skipped: `${c.dim}· skipped${c.reset}`,
  error: `${c.red}! error${c.reset}`,
};

function nowClock(): string {
  // No Date import quirks; local HH:MM:SS for the line we print.
  return new Date().toISOString().slice(11, 19);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

let count = 0;
let matched = 0;
let cost = 0;

function printLine(raw: string): void {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(raw);
  } catch {
    return; // partial line during write; tail -f will resend completed lines
  }

  if (rec.type === 'meta') {
    console.log(
      `${c.bold}${c.cyan}── backfill report (${rec.mode}) started ${rec.generated_at} ──${c.reset}`,
    );
    return;
  }

  count++;
  const outcome = String(rec.outcome ?? '');
  if (outcome === 'matched' || outcome === 'applied') matched++;
  cost += Number(rec.cost_usd ?? 0);

  if (VERBOSE) {
    printVerbose(rec, outcome);
    return;
  }

  const icon = ICON[outcome] ?? outcome;
  const id = `${rec.record_table ?? '?'}/${rec.record_id ?? '?'}`;
  const entity = truncate(String(rec.entity_name ?? ''), 28);
  const claim = truncate(String(rec.claim ?? rec.description ?? ''), 70);

  console.log(
    `${c.dim}${nowClock()}${c.reset} ${icon} ${c.cyan}${id}${c.reset} ${entity} ${c.dim}—${c.reset} ${claim}`,
  );

  // For misses, show why: the run's reason + a compact tally of why each
  // candidate URL was rejected (e.g. "3 candidates: too-short ×2, no-quote ×1").
  if (outcome === 'no-match' || outcome === 'skipped' || outcome === 'error') {
    const reason = String(rec.reason ?? '').trim();
    if (reason) {
      console.log(`           ${c.red}↳${c.reset} ${c.dim}${truncate(reason, 90)}${c.reset}`);
    }
    const cands = Array.isArray(rec.candidates) ? (rec.candidates as Record<string, unknown>[]) : [];
    if (cands.length) {
      const tally = new Map<string, number>();
      for (const cand of cands) {
        const r = String(cand.rejection_reason ?? cand.decision ?? 'unknown');
        tally.set(r, (tally.get(r) ?? 0) + 1);
      }
      const parts = [...tally.entries()].map(([r, n]) => (n > 1 ? `${r} ×${n}` : r));
      console.log(`             ${c.dim}${cands.length} candidate(s): ${parts.join(', ')}${c.reset}`);
    }
  }
  if (count % 10 === 0) {
    console.log(
      `${c.yellow}   ▸ ${count} records, ${matched} matched, $${cost.toFixed(2)} so far${c.reset}`,
    );
  }
}

/** Full structured dump of one record: the conclusion, then the evidence. */
function printVerbose(rec: Record<string, unknown>, outcome: string): void {
  const icon = ICON[outcome] ?? outcome;
  const id = `${rec.record_table ?? '?'}/${rec.record_id ?? '?'}`;

  console.log(`\n${c.bold}${'═'.repeat(72)}${c.reset}`);
  console.log(`${icon}  ${c.cyan}${c.bold}${id}${c.reset}  ${c.dim}#${count}${c.reset}`);
  console.log(`  ${c.dim}entity:${c.reset} ${rec.entity_name ?? '(none)'}`);
  if (rec.description) console.log(`  ${c.dim}desc:  ${c.reset} ${rec.description}`);
  console.log(`  ${c.dim}claim: ${c.reset} ${rec.claim ?? ''}`);
  console.log(`  ${c.dim}cost:  ${c.reset} $${Number(rec.cost_usd ?? 0).toFixed(4)}`);
  if (rec.reason) console.log(`  ${c.dim}reason:${c.reset} ${rec.reason}`);

  // The conclusion: the URL it chose (matched) and the quotes that justified it.
  if (outcome === 'matched' || outcome === 'applied') {
    console.log(`  ${c.green}→ matched:${c.reset} ${rec.url} ${c.dim}(${rec.provider ?? '?'})${c.reset}`);
    const quotes = Array.isArray(rec.quotes) ? (rec.quotes as string[]) : [];
    if (quotes.length) {
      console.log(`  ${c.dim}supporting quotes:${c.reset}`);
      quotes.forEach((q, i) => console.log(`    ${i + 1}. ${c.green}"${truncate(q, 160)}"${c.reset}`));
    }
    const yw = rec.yaml_write as Record<string, unknown> | null;
    if (yw) {
      const ok = yw.status === 'ok' || yw.status === 'written';
      const tag = ok ? `${c.green}${yw.status}${c.reset}` : `${c.red}${yw.status}${c.reset}`;
      console.log(`  ${c.dim}yaml_write:${c.reset} ${tag} ${c.dim}${yw.filepath ?? ''}${yw.error ? ' — ' + yw.error : ''}${c.reset}`);
    }
  }

  // The evidence: every candidate URL considered, and why it was kept/dropped.
  const cands = Array.isArray(rec.candidates) ? (rec.candidates as Record<string, unknown>[]) : [];
  console.log(`  ${c.dim}candidates (${cands.length}):${c.reset}`);
  cands.forEach((cand, i) => {
    const accepted = cand.decision === 'accepted';
    const mark = accepted ? `${c.green}✓ accepted${c.reset}` : `${c.red}✗ ${cand.rejection_reason ?? cand.decision}${c.reset}`;
    const chars = cand.content_chars != null ? `${c.dim} ${cand.content_chars}c${c.reset}` : '';
    console.log(`    ${c.dim}[${i + 1}]${c.reset} ${mark}${chars}  ${cand.url}`);
    if (cand.title) console.log(`        ${c.dim}${truncate(String(cand.title), 90)}${c.reset}`);

    // Why an entity-mention check failed: the name variants it looked for.
    const slots = cand.missing_slots as unknown[] | undefined;
    if (Array.isArray(slots) && slots.length) {
      const names = slots.map((s) => (Array.isArray(s) ? s.join(' / ') : String(s)));
      console.log(`        ${c.dim}missing entity: ${truncate(names.join('  |  '), 90)}${c.reset}`);
    }

    // Quotes Haiku extracted for this candidate (the raw evidence the judge saw).
    const qe = cand.quote_extraction as Record<string, unknown> | null;
    const haiku = qe?.haiku as Record<string, unknown> | undefined;
    const hq = Array.isArray(haiku?.quotes) ? (haiku!.quotes as string[]) : [];
    const verified = Array.isArray(cand.quote_extraction)
      ? []
      : (qe?.['haiku_verified_quotes'] as string[] | undefined) ?? [];
    if (hq.length) {
      console.log(`        ${c.dim}extracted ${hq.length} quote(s), ${verified.length} verified${c.reset}`);
      hq.forEach((q) => console.log(`          ${c.dim}· "${truncate(q, 140)}"${c.reset}`));
    }
  });
}

function main(): void {
  const { pod, file } = discover();
  console.log(
    `${c.bold}Tailing ${file}${c.reset}\n${c.dim}pod ${pod} · ctrl-c to stop${c.reset}\n`,
  );

  const child = spawn(
    'kubectl',
    ['--context', CTX, '-n', NS, 'exec', pod, '--', 'tail', '-n', '+1', '-f', file],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );

  const rl = createInterface({ input: child.stdout });
  rl.on('line', printLine);

  const bye = () => {
    child.kill('SIGTERM');
    console.log(
      `\n${c.bold}stopped — ${count} records, ${matched} matched, $${cost.toFixed(2)}${c.reset}`,
    );
    process.exit(0);
  };
  process.on('SIGINT', bye);
  child.on('exit', () => process.exit(0));
}

main();
