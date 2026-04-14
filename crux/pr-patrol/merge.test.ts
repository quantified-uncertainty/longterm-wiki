/**
 * Tests for crux/pr-patrol/merge.ts
 *
 * QUA-473 regression: `enqueuePullRequestForMerge` is a phantom mutation —
 * it does not exist on GitHub's GraphQL schema and every call failed
 * at runtime with `Field 'enqueuePullRequestForMerge' doesn't exist on
 * type 'Mutation'`. The correct mutation is `enablePullRequestAutoMerge`
 * with input type `EnablePullRequestAutoMergeInput`.
 *
 * These tests lock in the correct mutation name + shape so nobody can
 * regress it again without failing CI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the github lib BEFORE importing the module under test.
vi.mock('../lib/github.ts', () => ({
  REPO: 'quantified-uncertainty/longterm-wiki',
  githubApi: vi.fn(),
  githubGraphQL: vi.fn(),
}));

// Mock state.ts so we don't touch the real ~/.cache/pr-patrol JSONL file
// or try to create directories during unit tests.
vi.mock('./state.ts', () => ({
  appendJsonl: vi.fn(),
  cl: new Proxy({}, { get: () => '' }),
  JSONL_FILE: '/tmp/test-runs.jsonl',
  log: vi.fn(),
}));

// Mock comments.ts to avoid real comment-posting over HTTP.
vi.mock('./comments.ts', () => ({
  buildEnqueuedComment: vi.fn(() => 'enqueued'),
  buildEnqueueFailedComment: vi.fn((reason: string) => `failed: ${reason}`),
  postEventComment: vi.fn().mockResolvedValue(undefined),
}));

// Mock pr-analysis re-exports — merge.ts only re-exports them, the tests
// don't exercise them, but vitest resolves the whole import graph.
vi.mock('../lib/pr-analysis/index.ts', () => ({
  checkMergeEligibility: vi.fn(),
  findMergeCandidates: vi.fn(),
}));

import { enqueuePr } from './merge.ts';
import * as githubLib from '../lib/github.ts';
import type { MergeCandidate, PatrolConfig } from './types.ts';

const mockGraphQL = vi.mocked(githubLib.githubGraphQL);
const mockApi = vi.mocked(githubLib.githubApi);

function makeCandidate(overrides: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    number: 4242,
    title: 'Example PR',
    branch: 'claude/qua-999-example',
    createdAt: '2026-04-13T00:00:00Z',
    headOid: 'deadbeefcafebabe1234567890abcdef12345678',
    nodeId: 'PR_kwDOtest4242',
    eligible: true,
    blockReasons: [],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<PatrolConfig> = {}): PatrolConfig {
  return {
    repo: 'quantified-uncertainty/longterm-wiki',
    intervalSeconds: 60,
    maxTurns: 10,
    cooldownSeconds: 300,
    staleHours: 72,
    model: 'sonnet',
    skipPerms: false,
    once: false,
    dryRun: false,
    verbose: false,
    reflectionInterval: 5,
    timeoutMinutes: 30,
    ...overrides,
  };
}

describe('enqueuePr (QUA-473)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The `addLabel` call goes through githubApi — default to success.
    mockApi.mockResolvedValue(undefined);
  });

  it('uses the `enablePullRequestAutoMerge` mutation (NOT the phantom `enqueuePullRequestForMerge`)', async () => {
    // First GraphQL call is the mutation; second call (if any) is the
    // status-probe query from isInMergeQueue() fallback path.
    mockGraphQL.mockResolvedValueOnce({
      enablePullRequestAutoMerge: {
        pullRequest: {
          id: 'PR_kwDOtest4242',
          autoMergeRequest: { enabledAt: '2026-04-13T10:00:00Z' },
        },
      },
    } as unknown as never);

    const outcome = await enqueuePr(makeCandidate(), makeConfig());

    expect(outcome).toBe('enqueued');

    // At least one GraphQL call happened — the first one is the mutation.
    expect(mockGraphQL).toHaveBeenCalled();
    const [mutation, variables] = mockGraphQL.mock.calls[0];
    const mutationStr = String(mutation);

    // Positive assertion: the correct mutation name is present.
    expect(mutationStr).toContain('enablePullRequestAutoMerge');
    // Regression guard: the phantom name must never come back.
    expect(mutationStr).not.toContain('enqueuePullRequestForMerge');

    // Input shape: must pass pullRequestId + expectedHeadOid + mergeMethod.
    expect(mutationStr).toContain('pullRequestId: $prId');
    expect(mutationStr).toContain('expectedHeadOid: $expectedHeadOid');
    expect(mutationStr).toContain('mergeMethod:');

    // Variable declarations must match the variables actually passed so
    // GraphQL doesn't reject with "variable declared but not used".
    expect(mutationStr).toContain('$prId: ID!');
    expect(mutationStr).toContain('$expectedHeadOid: GitObjectID');

    // Variables are forwarded from the candidate.
    expect(variables).toEqual({
      prId: 'PR_kwDOtest4242',
      expectedHeadOid: 'deadbeefcafebabe1234567890abcdef12345678',
    });
  });

  it('uses MERGE as the merge method (repo uses merge commits, not squash)', async () => {
    mockGraphQL.mockResolvedValueOnce({
      enablePullRequestAutoMerge: {
        pullRequest: { id: 'x', autoMergeRequest: { enabledAt: 'x' } },
      },
    } as unknown as never);

    await enqueuePr(makeCandidate(), makeConfig());

    const mutationStr = String(mockGraphQL.mock.calls[0][0]);
    expect(mutationStr).toContain('mergeMethod: MERGE');
  });

  it('dry-run mode does not call the GraphQL mutation', async () => {
    const outcome = await enqueuePr(
      makeCandidate(),
      makeConfig({ dryRun: true }),
    );
    expect(outcome).toBe('dry-run');
    expect(mockGraphQL).not.toHaveBeenCalled();
  });
});
