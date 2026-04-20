/**
 * Calibration Analyzer (QUA-635)
 *
 * Loads results-{haiku,sonnet}.json and computes:
 *  - Precision, recall, F1 on the known-true / known-false split
 *  - False-confirm rate (critical metric for the defensive invariant)
 *  - Per-category breakdown (personnel, publication, funding-round)
 *  - Quoted-text fidelity (% of extracted_value substrings that appear in source)
 *  - Inter-model agreement
 *  - Cost + latency per item
 *
 * Emits: crux/calibration/data/metrics.json + console table
 */

import { readFileSync, writeFileSync } from 'node:fs';

interface RunResult {
  itemId: string;
  label: 'true' | 'false';
  recordType: string;
  description: string;
  sourceUrl: string;
  verdict: string | null;
  confidence: number | null;
  extractedValue: string;
  reasoning: string;
  quoteFidelityHit: boolean | null;
  quoteFidelityExample: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

interface RunFile {
  runAt: string;
  model: string;
  modelId: string;
  itemsProcessed: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  results: RunResult[];
}

function loadRun(model: 'haiku' | 'sonnet'): RunFile {
  const path = new URL(`./data/results-${model}.json`, import.meta.url).pathname;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ── Metric computation ────────────────────────────────────────────

/** Treat confirmed/partial as "positive (claim supported)". contradicted/outdated/unverifiable as "negative". */
function classifyOutcome(verdict: string | null): 'positive' | 'negative' | 'error' {
  if (!verdict) return 'error';
  if (verdict === 'confirmed' || verdict === 'partial') return 'positive';
  return 'negative';
}

interface TypedMetrics {
  n: number;
  confirmed: number;
  contradicted: number;
  unverifiable: number;
  partial: number;
  outdated: number;
  error: number;
  /** % of items the model classified as 'confirmed' (strict — excludes partial). */
  strictConfirmRate: number;
  /** % classified as confirmed OR partial (loose — counts as positive). */
  looseConfirmRate: number;
  quoteFidelityHit: number;
  quoteFidelityN: number;
  costUsd: number;
  avgLatencyMs: number;
}

function tally(results: RunResult[]): TypedMetrics {
  const m: TypedMetrics = {
    n: results.length,
    confirmed: 0, contradicted: 0, unverifiable: 0, partial: 0, outdated: 0, error: 0,
    strictConfirmRate: 0, looseConfirmRate: 0,
    quoteFidelityHit: 0, quoteFidelityN: 0,
    costUsd: 0, avgLatencyMs: 0,
  };
  let latencySum = 0;
  for (const r of results) {
    if (r.error) { m.error++; continue; }
    if (r.verdict === 'confirmed') m.confirmed++;
    else if (r.verdict === 'contradicted') m.contradicted++;
    else if (r.verdict === 'unverifiable') m.unverifiable++;
    else if (r.verdict === 'partial') m.partial++;
    else if (r.verdict === 'outdated') m.outdated++;
    else m.error++;

    if (r.quoteFidelityHit != null) {
      m.quoteFidelityN++;
      if (r.quoteFidelityHit) m.quoteFidelityHit++;
    }
    m.costUsd += r.costUsd;
    latencySum += r.latencyMs;
  }
  m.strictConfirmRate = m.n ? m.confirmed / m.n : 0;
  m.looseConfirmRate = m.n ? (m.confirmed + m.partial) / m.n : 0;
  m.avgLatencyMs = m.n ? latencySum / m.n : 0;
  return m;
}

function fmt(n: number, decimals = 1): string {
  return (n * 100).toFixed(decimals) + '%';
}

function analyzeModel(model: 'haiku' | 'sonnet', file: RunFile) {
  const all = file.results;
  const trueItems = all.filter(r => r.label === 'true');
  const falseItems = all.filter(r => r.label === 'false');

  const trueM = tally(trueItems);
  const falseM = tally(falseItems);

  // Critical metrics
  // Recall = % of known-true that got confirmed/partial
  const recallStrict = trueItems.filter(r => r.verdict === 'confirmed').length / trueItems.length;
  const recallLoose = trueItems.filter(r => r.verdict === 'confirmed' || r.verdict === 'partial').length / trueItems.length;
  // False-confirm rate = % of known-false that got confirmed (the defensive-invariant killer)
  const falseConfirmStrict = falseItems.filter(r => r.verdict === 'confirmed').length / falseItems.length;
  const falseConfirmLoose = falseItems.filter(r => r.verdict === 'confirmed' || r.verdict === 'partial').length / falseItems.length;
  // Precision = when model says confirmed, how often is it actually a true item
  const confirmedPositives = all.filter(r => r.verdict === 'confirmed').length;
  const precisionStrict = confirmedPositives
    ? all.filter(r => r.verdict === 'confirmed' && r.label === 'true').length / confirmedPositives
    : 0;

  const perType: Record<string, { true: TypedMetrics; false: TypedMetrics }> = {};
  for (const t of ['personnel', 'publication', 'funding-round']) {
    perType[t] = {
      true: tally(trueItems.filter(r => r.recordType === t)),
      false: tally(falseItems.filter(r => r.recordType === t)),
    };
  }

  return {
    model,
    modelId: file.modelId,
    itemsProcessed: all.length,
    totalCostUsd: file.totalCostUsd,
    costPerItemUsd: file.totalCostUsd / all.length,
    avgLatencyMs: all.reduce((s, r) => s + r.latencyMs, 0) / all.length,

    // Headline metrics
    recallStrict,       // of 50 known-true, fraction marked `confirmed`
    recallLoose,        // ... marked `confirmed` or `partial`
    falseConfirmStrict, // CRITICAL: of 50 known-false, fraction marked `confirmed`
    falseConfirmLoose,  // ... marked `confirmed` or `partial`
    precisionStrict,    // when model says `confirmed`, P(item was actually true)

    // Verdict distributions
    knownTrueVerdicts: trueM,
    knownFalseVerdicts: falseM,

    // Per-category
    perType,

    // Quote fidelity (both splits)
    quoteFidelityRateTrue: trueM.quoteFidelityN ? trueM.quoteFidelityHit / trueM.quoteFidelityN : 0,
    quoteFidelityRateFalse: falseM.quoteFidelityN ? falseM.quoteFidelityHit / falseM.quoteFidelityN : 0,
  };
}

// ── Failure-mode analysis ────────────────────────────────────────

function findFailures(haikuFile: RunFile, sonnetFile: RunFile) {
  const haiku = new Map(haikuFile.results.map(r => [r.itemId, r]));
  const sonnet = new Map(sonnetFile.results.map(r => [r.itemId, r]));
  const failures: Array<{
    kind: string;
    itemId: string;
    label: string;
    description: string;
    haikuVerdict: string | null;
    sonnetVerdict: string | null;
    haikuReasoning: string;
    sonnetReasoning: string;
    sourceUrl: string;
  }> = [];

  for (const [id, h] of haiku) {
    const s = sonnet.get(id);
    if (!s) continue;
    if (h.error || s.error) continue;

    // Haiku false-confirm (CRITICAL)
    if (h.label === 'false' && h.verdict === 'confirmed') {
      failures.push({
        kind: 'haiku-false-confirm',
        itemId: id, label: h.label, description: h.description,
        haikuVerdict: h.verdict, sonnetVerdict: s.verdict,
        haikuReasoning: h.reasoning, sonnetReasoning: s.reasoning,
        sourceUrl: h.sourceUrl,
      });
    }
    // Sonnet false-confirm
    if (s.label === 'false' && s.verdict === 'confirmed') {
      failures.push({
        kind: 'sonnet-false-confirm',
        itemId: id, label: s.label, description: s.description,
        haikuVerdict: h.verdict, sonnetVerdict: s.verdict,
        haikuReasoning: h.reasoning, sonnetReasoning: s.reasoning,
        sourceUrl: h.sourceUrl,
      });
    }
    // Haiku missed confirm (false-negative)
    if (h.label === 'true' && h.verdict !== 'confirmed' && h.verdict !== 'partial') {
      failures.push({
        kind: 'haiku-missed-confirm',
        itemId: id, label: h.label, description: h.description,
        haikuVerdict: h.verdict, sonnetVerdict: s.verdict,
        haikuReasoning: h.reasoning, sonnetReasoning: s.reasoning,
        sourceUrl: h.sourceUrl,
      });
    }
    // Models disagree
    if (h.verdict !== s.verdict && !['haiku-false-confirm','sonnet-false-confirm','haiku-missed-confirm'].some(k => failures.some(f => f.itemId === id && f.kind === k))) {
      failures.push({
        kind: 'disagreement',
        itemId: id, label: h.label, description: h.description,
        haikuVerdict: h.verdict, sonnetVerdict: s.verdict,
        haikuReasoning: h.reasoning, sonnetReasoning: s.reasoning,
        sourceUrl: h.sourceUrl,
      });
    }
  }
  return failures;
}

// ── Inter-model agreement ────────────────────────────────────────

function agreement(haikuFile: RunFile, sonnetFile: RunFile) {
  const haiku = new Map(haikuFile.results.map(r => [r.itemId, r.verdict]));
  const sonnet = new Map(sonnetFile.results.map(r => [r.itemId, r.verdict]));
  let total = 0, agree = 0;
  for (const [id, hv] of haiku) {
    const sv = sonnet.get(id);
    if (hv == null || sv == null) continue;
    total++;
    if (hv === sv) agree++;
  }
  return total ? agree / total : 0;
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  const haikuFile = loadRun('haiku');
  const sonnetFile = loadRun('sonnet');

  const haiku = analyzeModel('haiku', haikuFile);
  const sonnet = analyzeModel('sonnet', sonnetFile);
  const agreementRate = agreement(haikuFile, sonnetFile);
  const failures = findFailures(haikuFile, sonnetFile);

  const metrics = {
    runAt: new Date().toISOString(),
    corpus: {
      total: haikuFile.itemsProcessed,
      knownTrue: haikuFile.results.filter(r => r.label === 'true').length,
      knownFalse: haikuFile.results.filter(r => r.label === 'false').length,
    },
    models: { haiku, sonnet },
    interModelAgreementRate: agreementRate,
    failures,
    failureSummary: {
      haikuFalseConfirms: failures.filter(f => f.kind === 'haiku-false-confirm').length,
      sonnetFalseConfirms: failures.filter(f => f.kind === 'sonnet-false-confirm').length,
      haikuMissedConfirms: failures.filter(f => f.kind === 'haiku-missed-confirm').length,
      disagreements: failures.filter(f => f.kind === 'disagreement').length,
    },
  };

  const outputPath = new URL('./data/metrics.json', import.meta.url).pathname;
  writeFileSync(outputPath, JSON.stringify(metrics, null, 2));

  // ── Console report ──
  console.log('\n=== Calibration Results (QUA-635) ===\n');
  console.log(`Corpus: ${metrics.corpus.total} items (${metrics.corpus.knownTrue} known-true + ${metrics.corpus.knownFalse} known-false)`);
  console.log();

  const row = (name: string, h: number | string, s: number | string) =>
    `  ${name.padEnd(34)}  ${String(h).padStart(10)}  ${String(s).padStart(10)}`;

  console.log('  ' + 'METRIC'.padEnd(34) + '  ' + 'HAIKU'.padStart(10) + '  ' + 'SONNET'.padStart(10));
  console.log('  ' + '─'.repeat(60));
  console.log(row('Recall (confirmed only)', fmt(haiku.recallStrict), fmt(sonnet.recallStrict)));
  console.log(row('Recall (confirmed+partial)', fmt(haiku.recallLoose), fmt(sonnet.recallLoose)));
  console.log(row('False-confirm (strict)', fmt(haiku.falseConfirmStrict), fmt(sonnet.falseConfirmStrict)));
  console.log(row('False-confirm (loose: confirm+partial)', fmt(haiku.falseConfirmLoose), fmt(sonnet.falseConfirmLoose)));
  console.log(row('Precision @ confirmed', fmt(haiku.precisionStrict), fmt(sonnet.precisionStrict)));
  console.log(row('Quote fidelity (true items)', fmt(haiku.quoteFidelityRateTrue), fmt(sonnet.quoteFidelityRateTrue)));
  console.log(row('Quote fidelity (false items)', fmt(haiku.quoteFidelityRateFalse), fmt(sonnet.quoteFidelityRateFalse)));
  console.log(row('Cost / item', '$' + haiku.costPerItemUsd.toFixed(4), '$' + sonnet.costPerItemUsd.toFixed(4)));
  console.log(row('Total cost (100 items)', '$' + haiku.totalCostUsd.toFixed(2), '$' + sonnet.totalCostUsd.toFixed(2)));
  console.log(row('Avg latency / item', Math.round(haiku.avgLatencyMs) + 'ms', Math.round(sonnet.avgLatencyMs) + 'ms'));

  console.log(`\n  Inter-model verdict agreement: ${fmt(agreementRate)} (${Math.round(agreementRate * metrics.corpus.total)}/${metrics.corpus.total})`);

  console.log('\n  Per-type (known-true confirmation rate):');
  for (const t of ['personnel', 'publication', 'funding-round']) {
    const h = haiku.perType[t].true;
    const s = sonnet.perType[t].true;
    console.log(`    ${t.padEnd(18)} haiku: ${h.confirmed}/${h.n} (${fmt(h.strictConfirmRate)})  sonnet: ${s.confirmed}/${s.n} (${fmt(s.strictConfirmRate)})`);
  }

  console.log('\n  Per-type (known-false false-confirm rate — lower is better):');
  for (const t of ['personnel', 'publication', 'funding-round']) {
    const h = haiku.perType[t].false;
    const s = sonnet.perType[t].false;
    console.log(`    ${t.padEnd(18)} haiku: ${h.confirmed}/${h.n} (${fmt(h.strictConfirmRate)})  sonnet: ${s.confirmed}/${s.n} (${fmt(s.strictConfirmRate)})`);
  }

  console.log(`\n  Failure summary:`);
  console.log(`    Haiku false-confirms:  ${metrics.failureSummary.haikuFalseConfirms}`);
  console.log(`    Sonnet false-confirms: ${metrics.failureSummary.sonnetFalseConfirms}`);
  console.log(`    Haiku missed-confirms: ${metrics.failureSummary.haikuMissedConfirms}`);
  console.log(`    Disagreements (other): ${metrics.failureSummary.disagreements}`);

  console.log(`\n✓ Wrote full metrics to ${outputPath}`);
}

main();
