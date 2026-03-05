/**
 * Tests for CI orchestration utilities.
 *
 * Tests the pure helper functions (file allow-list) that are used by the
 * CI orchestrator. The orchestrator itself is integration-heavy (git, GitHub API,
 * subprocesses) and is covered by the workflow's own CI run.
 */

import { describe, it, expect } from 'vitest';
import { isAutoUpdateAllowedFile } from './ci-orchestrate.ts';

// ── isAutoUpdateAllowedFile ──────────────────────────────────────────────────

describe('isAutoUpdateAllowedFile', () => {
  it('allows content MDX files', () => {
    expect(isAutoUpdateAllowedFile('content/docs/ai-safety.mdx')).toBe(true);
    expect(isAutoUpdateAllowedFile('content/docs/internal/dashboard.mdx')).toBe(true);
    expect(isAutoUpdateAllowedFile('content/docs/people/john-doe.mdx')).toBe(true);
  });

  it('allows data YAML files', () => {
    expect(isAutoUpdateAllowedFile('data/entities/orgs.yaml')).toBe(true);
    expect(isAutoUpdateAllowedFile('data/auto-update/state.yml')).toBe(true);
    expect(isAutoUpdateAllowedFile('data/auto-update/runs/2026-03-04.yaml')).toBe(true);
    expect(isAutoUpdateAllowedFile('data/facts/ai-safety.yaml')).toBe(true);
  });

  it('rejects TypeScript files', () => {
    expect(isAutoUpdateAllowedFile('crux/commands/auto-update.ts')).toBe(false);
    expect(isAutoUpdateAllowedFile('apps/web/src/app/page.tsx')).toBe(false);
  });

  it('rejects config and env files', () => {
    expect(isAutoUpdateAllowedFile('.env')).toBe(false);
    expect(isAutoUpdateAllowedFile('package.json')).toBe(false);
    expect(isAutoUpdateAllowedFile('pnpm-lock.yaml')).toBe(false);
    expect(isAutoUpdateAllowedFile('tsconfig.json')).toBe(false);
  });

  it('rejects workflow files', () => {
    expect(isAutoUpdateAllowedFile('.github/workflows/auto-update.yml')).toBe(false);
    expect(isAutoUpdateAllowedFile('.github/workflows/ci.yml')).toBe(false);
  });

  it('rejects non-MDX content files', () => {
    expect(isAutoUpdateAllowedFile('content/docs/ai-safety.md')).toBe(false);
    expect(isAutoUpdateAllowedFile('content/docs/ai-safety.txt')).toBe(false);
  });

  it('rejects files outside content/docs and data directories', () => {
    expect(isAutoUpdateAllowedFile('apps/web/src/data/pages.json')).toBe(false);
    expect(isAutoUpdateAllowedFile('docs/README.md')).toBe(false);
  });

  it('rejects paths with directory traversal', () => {
    expect(isAutoUpdateAllowedFile('../content/docs/evil.mdx')).toBe(false);
    expect(isAutoUpdateAllowedFile('content/../.env')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isAutoUpdateAllowedFile('')).toBe(false);
  });
});
