import { describe, it, expect } from 'vitest';
import { shouldWriteToServer } from '../wiki-server-env.mjs';

const PROD = 'https://wiki-server.k8s.quantifieduncertainty.org';
const gha = (event, ref) => ({ GITHUB_ACTIONS: 'true', CI: 'true', GITHUB_EVENT_NAME: event, GITHUB_REF: ref });

describe('shouldWriteToServer', () => {
  describe('GitHub Actions', () => {
    it('refuses writes from pull_request builds (the bug: PR CI wrote to prod)', () => {
      expect(shouldWriteToServer(gha('pull_request', 'refs/pull/123/merge'), PROD).write).toBe(false);
      expect(shouldWriteToServer(gha('pull_request_target', 'refs/heads/main'), PROD).write).toBe(false);
      expect(shouldWriteToServer(gha('merge_group', 'refs/heads/main'), PROD).write).toBe(false);
    });

    it('keeps writing on push to main and production (unchanged prod behaviour)', () => {
      expect(shouldWriteToServer(gha('push', 'refs/heads/main'), PROD).write).toBe(true);
      expect(shouldWriteToServer(gha('push', 'refs/heads/production'), PROD).write).toBe(true);
    });

    it('keeps writing for scheduled / manual runs on main', () => {
      expect(shouldWriteToServer(gha('schedule', 'refs/heads/main'), PROD).write).toBe(true);
      expect(shouldWriteToServer(gha('workflow_dispatch', 'refs/heads/main'), PROD).write).toBe(true);
    });

    it('refuses manual runs on a feature branch', () => {
      expect(shouldWriteToServer(gha('workflow_dispatch', 'refs/heads/claude/foo'), PROD).write).toBe(false);
      expect(shouldWriteToServer(gha('push', ''), PROD).write).toBe(false);
    });
  });

  describe('Vercel', () => {
    it('writes from production deployments', () => {
      expect(shouldWriteToServer({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'production' }, PROD).write).toBe(true);
    });

    it('writes from main/production-branch builds whatever VERCEL_ENV says', () => {
      expect(shouldWriteToServer({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'production' }, PROD).write).toBe(true);
      expect(shouldWriteToServer({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'main' }, PROD).write).toBe(true);
    });

    it('refuses preview builds of other branches', () => {
      expect(shouldWriteToServer({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'claude/foo' }, PROD).write).toBe(false);
      expect(shouldWriteToServer({ VERCEL: '1' }, PROD).write).toBe(false);
    });
  });

  describe('dev machine / agent slot', () => {
    it('writes to a local wiki-server', () => {
      expect(shouldWriteToServer({}, 'http://localhost:3113').write).toBe(true);
      expect(shouldWriteToServer({}, 'http://127.0.0.1:3100').write).toBe(true);
      expect(shouldWriteToServer({}, 'http://[::1]:3100').write).toBe(true);
    });

    it('does not write to a remote server without opt-in', () => {
      expect(shouldWriteToServer({}, PROD).write).toBe(false);
      expect(shouldWriteToServer({}, 'http://localhost.evil.example').write).toBe(false);
      expect(shouldWriteToServer({}, 'not a url').write).toBe(false);
      expect(shouldWriteToServer({}, '').write).toBe(false);
    });
  });

  describe('BUILD_DATA_SERVER_WRITES override', () => {
    it('=1 forces writes anywhere', () => {
      expect(shouldWriteToServer({ BUILD_DATA_SERVER_WRITES: '1' }, PROD).write).toBe(true);
      expect(shouldWriteToServer({ ...gha('pull_request', 'refs/pull/1/merge'), BUILD_DATA_SERVER_WRITES: '1' }, PROD).write).toBe(true);
    });

    it('=0 disables writes even on main', () => {
      expect(shouldWriteToServer({ ...gha('push', 'refs/heads/main'), BUILD_DATA_SERVER_WRITES: '0' }, PROD).write).toBe(false);
      expect(shouldWriteToServer({ BUILD_DATA_SERVER_WRITES: '0' }, 'http://localhost:3113').write).toBe(false);
    });
  });

  it('always returns a human-readable reason', () => {
    const r = shouldWriteToServer(gha('pull_request', 'refs/pull/9/merge'), PROD);
    expect(r.reason).toBe('GitHub Actions pull_request event');
  });
});
