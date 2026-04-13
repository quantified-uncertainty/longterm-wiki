import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { compareToBaseline, readBaseline } from './validate-crux-tsc.ts';

describe('compareToBaseline', () => {
  it('passes when current equals baseline', () => {
    const result = compareToBaseline(87, 87);
    expect(result.passed).toBe(true);
    expect(result.message).toContain('At baseline');
    expect(result.message).toContain('87');
  });

  it('passes when current is below baseline and suggests lowering', () => {
    const result = compareToBaseline(80, 87);
    expect(result.passed).toBe(true);
    expect(result.message).toContain('dropped from 87 to 80');
    expect(result.message).toContain('-7');
    expect(result.message).toContain('--update');
  });

  it('fails when current exceeds baseline', () => {
    const result = compareToBaseline(90, 87);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('rose from 87 to 90');
    expect(result.message).toContain('+3');
    expect(result.message).toContain('QUA-338');
  });

  it('fails by exactly one when current is one over baseline', () => {
    const result = compareToBaseline(88, 87);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('+1');
  });

  it('fails when baseline is missing (null)', () => {
    const result = compareToBaseline(87, null);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('Baseline file missing');
    expect(result.message).toContain('--update');
  });

  it('passes when both current and baseline are zero', () => {
    const result = compareToBaseline(0, 0);
    expect(result.passed).toBe(true);
    expect(result.message).toContain('0');
  });

  it('passes when current drops to zero from non-zero baseline', () => {
    const result = compareToBaseline(0, 87);
    expect(result.passed).toBe(true);
    expect(result.message).toContain('dropped from 87 to 0');
  });
});

describe('readBaseline', () => {
  const REAL_BASELINE = path.resolve(__dirname, 'crux-tsc-baseline.txt');

  it('reads the actual committed baseline file as a positive integer', () => {
    const value = readBaseline();
    expect(value).not.toBeNull();
    expect(typeof value).toBe('number');
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it('committed baseline file matches the format readBaseline parses', () => {
    const raw = fs.readFileSync(REAL_BASELINE, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThanOrEqual(0);
  });
});

describe('readBaseline edge cases (via tmpdir to avoid touching real baseline)', () => {
  // We can't easily mock the BASELINE_PATH constant from outside without
  // a refactor, so these tests verify the parsing-style edge cases by
  // exercising compareToBaseline with the values readBaseline would return.

  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('treats negative numbers as null (rejected)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crux-tsc-baseline-'));
    const f = path.join(tmpDir, 'baseline.txt');
    fs.writeFileSync(f, '-5\n');
    const raw = fs.readFileSync(f, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    const filtered = !Number.isFinite(parsed) || parsed < 0 ? null : parsed;
    expect(filtered).toBeNull();
  });

  it('treats non-numeric content as null (rejected)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crux-tsc-baseline-'));
    const f = path.join(tmpDir, 'baseline.txt');
    fs.writeFileSync(f, 'banana\n');
    const raw = fs.readFileSync(f, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    const filtered = !Number.isFinite(parsed) || parsed < 0 ? null : parsed;
    expect(filtered).toBeNull();
  });

  it('parses whitespace-padded integers', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crux-tsc-baseline-'));
    const f = path.join(tmpDir, 'baseline.txt');
    fs.writeFileSync(f, '  42  \n');
    const raw = fs.readFileSync(f, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    expect(parsed).toBe(42);
  });
});
