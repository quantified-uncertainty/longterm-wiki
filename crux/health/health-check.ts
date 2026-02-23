#!/usr/bin/env node

/**
 * System Wellness Check
 *
 * Mirrors the checks in .github/workflows/wellness-check.yml so the same
 * health signals can be monitored locally or in ad-hoc debugging sessions.
 *
 * Usage:
 *   crux health                      Run all checks
 *   crux health --check=server       Server & DB only
 *   crux health --check=api          API smoke tests only
 *   crux health --check=actions      GitHub Actions workflow health
 *   crux health --check=frontend     Public frontend availability
 *   crux health --check=freshness    Data freshness
 *   crux health --json               JSON output
 */

import { getColors } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Config & types
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json') || args.includes('--ci');
const CHECK_ARG = args.find((a) => a.startsWith('--check='))?.split('=')[1];

const SERVER_URL = process.env.LONGTERMWIKI_SERVER_URL ?? '';
const API_KEY = process.env.LONGTERMWIKI_SERVER_API_KEY ?? '';
const WIKI_PUBLIC_URL = process.env.WIKI_PUBLIC_URL ?? '';

// Count lower bounds — alert if DB drops significantly below these baselines
const MIN_PAGES = 600;
const MIN_ENTITIES = 500;
const MIN_FACTS = 40; // Currently ~54; alert if drops dramatically

// Workflow staleness thresholds (hours)
const MAX_AGE: Record<string, number> = {
  'auto-update.yml': 36,
  'database-backup.yml': 36,
  'scheduled-maintenance.yml': 216, // 9 days
  'server-health-monitor.yml': 1,
  'scheduled-deploy.yml': 36,
  'ci.yml': 168, // 7 days
};

const c = getColors(JSON_MODE);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  ok: boolean;
  summary: string;
  detail?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchJson(url: string, authHeader?: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    let data: unknown = null;
    try { data = await res.json(); } catch { /* body may not be JSON */ }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null };
  }
}

function hoursAgo(isoString: string): number {
  const ms = Date.now() - new Date(isoString).getTime();
  return Math.round(ms / 3_600_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 1: Server & DB health
// ─────────────────────────────────────────────────────────────────────────────

async function checkServer(): Promise<CheckResult> {
  const name = 'Server & DB';
  const detail: string[] = [];
  const failures: string[] = [];

  if (!SERVER_URL) {
    return { name, ok: false, summary: 'LONGTERMWIKI_SERVER_URL not set', detail: ['Set LONGTERMWIKI_SERVER_URL environment variable'] };
  }

  const { ok, status, data } = await fetchJson(`${SERVER_URL}/health`);

  if (!ok) {
    return { name, ok: false, summary: `Health endpoint unreachable (HTTP ${status})`, detail: [`GET /health returned HTTP ${status}`] };
  }

  const h = data as Record<string, unknown>;
  const serverStatus = String(h.status ?? 'unknown');
  const dbStatus = String(h.database ?? 'unknown');
  const totalPages = Number(h.totalPages ?? 0);
  const totalEntities = Number(h.totalEntities ?? 0);
  const totalFacts = Number(h.totalFacts ?? 0);
  const totalIds = Number(h.totalIds ?? 0);
  const uptime = Number(h.uptime ?? 0);

  detail.push(`HTTP status: ${status}`);
  detail.push(`Server status: ${serverStatus}`);
  detail.push(`Database: ${dbStatus}`);
  detail.push(`Pages: ${totalPages} (min ${MIN_PAGES})`);
  detail.push(`Entities: ${totalEntities} (min ${MIN_ENTITIES})`);
  detail.push(`Facts: ${totalFacts} (min ${MIN_FACTS})`);
  detail.push(`Total IDs: ${totalIds}`);
  detail.push(`Uptime: ${uptime}s`);

  if (serverStatus !== 'healthy') failures.push(`status is '${serverStatus}' (expected 'healthy')`);
  if (dbStatus !== 'ok') failures.push(`database is '${dbStatus}' (expected 'ok')`);
  if (totalPages < MIN_PAGES) failures.push(`only ${totalPages} pages (expected ≥ ${MIN_PAGES})`);
  if (totalEntities < MIN_ENTITIES) failures.push(`only ${totalEntities} entities (expected ≥ ${MIN_ENTITIES})`);
  if (totalFacts < MIN_FACTS) failures.push(`only ${totalFacts} facts (expected ≥ ${MIN_FACTS})`);

  if (failures.length > 0) {
    return { name, ok: false, summary: failures.join('; '), detail };
  }
  return {
    name,
    ok: true,
    summary: `${totalPages} pages, ${totalEntities} entities, ${totalFacts} facts — uptime ${uptime}s`,
    detail,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 2: API smoke tests
// ─────────────────────────────────────────────────────────────────────────────

async function checkApi(): Promise<CheckResult> {
  const name = 'API smoke tests';
  const detail: string[] = [];
  const failures: string[] = [];

  if (!SERVER_URL) {
    return { name, ok: false, summary: 'LONGTERMWIKI_SERVER_URL not set' };
  }

  const auth = API_KEY ? `Bearer ${API_KEY}` : undefined;

  interface Smoke {
    label: string;
    url: string;
    check?: (data: unknown) => boolean;
  }

  // Response shapes verified against live server:
  //   search  → { results: [...], query, total }
  //   pages   → { pages: [...], total, limit, offset }
  //   entities → { entities: [...], total, limit, offset }
  //   sessions → { sessions: [...], total, limit, offset }
  const tests: Smoke[] = [
    {
      label: 'Search (existential risk)',
      url: `${SERVER_URL}/api/pages/search?q=existential+risk`,
      check: (d) => {
        const r = d as { results?: unknown[] };
        return Array.isArray(r.results) && r.results.length > 0;
      },
    },
    {
      label: 'Search (AI safety)',
      url: `${SERVER_URL}/api/pages/search?q=AI+safety`,
      check: (d) => {
        const r = d as { results?: unknown[] };
        return Array.isArray(r.results) && r.results.length > 0;
      },
    },
    {
      label: 'Pages list',
      url: `${SERVER_URL}/api/pages?limit=5`,
      check: (d) => {
        const r = d as { pages?: unknown[] };
        return Array.isArray(r.pages) && r.pages.length > 0;
      },
    },
    {
      label: 'Entities list',
      url: `${SERVER_URL}/api/entities?limit=5`,
      check: (d) => {
        const r = d as { entities?: unknown[] };
        return Array.isArray(r.entities) && r.entities.length > 0;
      },
    },
    {
      label: 'Sessions',
      url: `${SERVER_URL}/api/sessions?limit=1`,
      check: (d) => {
        // Just check it returns an object (may have 0 sessions)
        return d !== null && typeof d === 'object';
      },
    },
  ];

  for (const t of tests) {
    const { ok, status, data } = await fetchJson(t.url, auth);
    if (!ok) {
      detail.push(`FAIL  ${t.label}: HTTP ${status}`);
      failures.push(`${t.label}: HTTP ${status}`);
    } else if (t.check && !t.check(data)) {
      detail.push(`FAIL  ${t.label}: HTTP 200 but content check failed`);
      failures.push(`${t.label}: unexpected response shape`);
    } else {
      detail.push(`PASS  ${t.label}`);
    }
  }

  if (failures.length > 0) {
    return { name, ok: false, summary: `${failures.length} smoke test(s) failed`, detail };
  }
  return { name, ok: true, summary: `All ${tests.length} smoke tests passed`, detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 3: GitHub Actions workflow health
// ─────────────────────────────────────────────────────────────────────────────

interface WorkflowRun {
  status: string;
  conclusion: string | null;
  created_at: string;
  id: number;
}

interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
}

async function checkActions(): Promise<CheckResult> {
  const name = 'GitHub Actions';
  const detail: string[] = [];
  const failures: string[] = [];

  if (!process.env.GITHUB_TOKEN) {
    return { name, ok: false, summary: 'GITHUB_TOKEN not set', detail: ['Set GITHUB_TOKEN to enable workflow health checks'] };
  }

  const workflowFiles = [
    'auto-update.yml',
    'database-backup.yml',
    'scheduled-maintenance.yml',
    'server-health-monitor.yml',
    'scheduled-deploy.yml',
    'ci.yml',
  ];

  for (const wf of workflowFiles) {
    try {
      const resp = await githubApi<WorkflowRunsResponse>(
        `/repos/${REPO}/actions/workflows/${wf}/runs?per_page=5&status=completed`
      );
      const runs = resp.workflow_runs ?? [];
      const latest = runs[0];
      const maxAgeH = MAX_AGE[wf] ?? 48;

      if (!latest) {
        detail.push(`WARN  ${wf}: no completed runs found`);
        failures.push(`${wf}: no completed runs found`);
        continue;
      }

      const ageH = hoursAgo(latest.created_at);
      const requireSuccess = wf !== 'ci.yml'; // CI may fail legitimately on PRs

      if (ageH > maxAgeH) {
        detail.push(`FAIL  ${wf}: last run ${ageH}h ago (max ${maxAgeH}h)`);
        failures.push(`${wf}: stale (${ageH}h ago, max ${maxAgeH}h)`);
      } else if (requireSuccess && latest.conclusion !== 'success') {
        detail.push(`FAIL  ${wf}: last run concluded '${latest.conclusion}' (${ageH}h ago)`);
        failures.push(`${wf}: last run '${latest.conclusion}'`);
      } else {
        detail.push(`PASS  ${wf}: ${ageH}h ago (${latest.conclusion})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      detail.push(`SKIP  ${wf}: ${msg}`);
    }
  }

  if (failures.length > 0) {
    return { name, ok: false, summary: `${failures.length} workflow(s) unhealthy`, detail };
  }
  return { name, ok: true, summary: 'All monitored workflows are healthy', detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 4: Frontend availability
// ─────────────────────────────────────────────────────────────────────────────

async function checkFrontend(): Promise<CheckResult> {
  const name = 'Frontend';
  const detail: string[] = [];
  const failures: string[] = [];

  if (!WIKI_PUBLIC_URL) {
    return { name, ok: true, summary: 'Skipped (WIKI_PUBLIC_URL not set)', detail: ['Set WIKI_PUBLIC_URL to enable frontend checks'] };
  }

  const pages = [
    { label: 'Homepage', path: '/' },
    { label: 'Knowledge base', path: '/knowledge-base/' },
  ];

  for (const p of pages) {
    const url = `${WIKI_PUBLIC_URL}${p.path}`;
    const { ok, status } = await fetchJson(url);
    if (ok) {
      detail.push(`PASS  ${p.label}: HTTP 200`);
    } else {
      detail.push(`FAIL  ${p.label}: HTTP ${status}`);
      failures.push(`${p.label}: HTTP ${status}`);
    }
  }

  if (failures.length > 0) {
    return { name, ok: false, summary: `${failures.length} page(s) unavailable`, detail };
  }
  return { name, ok: true, summary: 'Frontend accessible', detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 5: Data freshness
// ─────────────────────────────────────────────────────────────────────────────

async function checkFreshness(): Promise<CheckResult> {
  const name = 'Data freshness';
  const detail: string[] = [];
  const failures: string[] = [];

  if (!SERVER_URL) {
    return { name, ok: false, summary: 'LONGTERMWIKI_SERVER_URL not set' };
  }

  const auth = API_KEY ? `Bearer ${API_KEY}` : undefined;

  // Most recently updated page — response: { pages: [...], total, limit, offset }
  const pagesResp = await fetchJson(`${SERVER_URL}/api/pages?limit=1`, auth);
  if (pagesResp.ok) {
    const p = pagesResp.data as { pages?: Array<{ updatedAt?: string; createdAt?: string }> };
    const page = p.pages?.[0];
    const date = page?.updatedAt ?? page?.createdAt;
    if (date) {
      const ageH = hoursAgo(date);
      if (ageH > 168) {
        failures.push(`Last page sync ${ageH}h ago (expected < 168h)`);
        detail.push(`WARN  Last page sync: ${ageH}h ago`);
      } else {
        detail.push(`PASS  Last page sync: ${ageH}h ago`);
      }
    } else {
      detail.push(`INFO  Last page sync: date unavailable`);
    }
  } else {
    detail.push(`FAIL  Pages list: HTTP ${pagesResp.status}`);
    failures.push(`Pages list unavailable (HTTP ${pagesResp.status})`);
  }

  // Most recent auto-update run — skip cleanly if endpoint returns 404 (route may not exist)
  const runsResp = await fetchJson(`${SERVER_URL}/api/auto-update-runs?limit=1`, auth);
  if (runsResp.status === 404) {
    detail.push(`INFO  Auto-update runs: endpoint not available`);
  } else if (runsResp.ok) {
    const r = runsResp.data as Array<{ createdAt?: string; startedAt?: string }>;
    const run = r[0];
    const date = run?.createdAt ?? run?.startedAt;
    if (date) {
      const ageH = hoursAgo(date);
      if (ageH > 48) {
        failures.push(`Last auto-update run ${ageH}h ago (expected < 48h)`);
        detail.push(`WARN  Last auto-update run: ${ageH}h ago`);
      } else {
        detail.push(`PASS  Last auto-update run: ${ageH}h ago`);
      }
    } else {
      detail.push(`INFO  Last auto-update run: no runs found`);
    }
  } else {
    detail.push(`SKIP  Auto-update runs: HTTP ${runsResp.status}`);
  }

  // Most recent agent session — response: { sessions: [...], total, limit, offset }
  const sessionsResp = await fetchJson(`${SERVER_URL}/api/sessions?limit=1`, auth);
  if (sessionsResp.ok) {
    const s = sessionsResp.data as { sessions?: Array<{ date?: string; createdAt?: string }> };
    const session = s.sessions?.[0];
    const date = session?.date ?? session?.createdAt;
    detail.push(`INFO  Last agent session: ${date ?? 'none found'}`);
  }

  if (failures.length > 0) {
    return { name, ok: false, summary: `${failures.length} freshness issue(s)`, detail };
  }
  return { name, ok: true, summary: 'Data freshness looks good', detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const ALL_CHECKS: Record<string, () => Promise<CheckResult>> = {
  server: checkServer,
  api: checkApi,
  actions: checkActions,
  frontend: checkFrontend,
  freshness: checkFreshness,
};

async function main(): Promise<void> {
  const toRun = CHECK_ARG
    ? [CHECK_ARG]
    : Object.keys(ALL_CHECKS);

  const results: CheckResult[] = [];

  for (const key of toRun) {
    const fn = ALL_CHECKS[key];
    if (!fn) {
      console.error(`Unknown check: ${key}. Available: ${Object.keys(ALL_CHECKS).join(', ')}`);
      process.exit(1);
    }
    if (!JSON_MODE) process.stdout.write(`  Running ${key}...`);
    const result = await fn();
    results.push(result);
    if (!JSON_MODE) {
      const icon = result.ok ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset}`;
      console.log(`\r  ${icon}  ${result.name.padEnd(24)} ${c.dim}${result.summary}${c.reset}`);
      if (result.detail && !result.ok) {
        for (const line of result.detail) {
          console.log(`        ${c.dim}${line}${c.reset}`);
        }
      }
    }
  }

  if (JSON_MODE) {
    console.log(JSON.stringify({ ok: results.every((r) => r.ok), checks: results }, null, 2));
  } else {
    const allOk = results.every((r) => r.ok);
    const failCount = results.filter((r) => !r.ok).length;
    console.log('');
    if (allOk) {
      console.log(`${c.green}${c.bold}  All checks passed${c.reset}`);
    } else {
      console.log(`${c.red}${c.bold}  ${failCount} check(s) failed${c.reset}`);
    }
    console.log('');
  }

  const allOk = results.every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
