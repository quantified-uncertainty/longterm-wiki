/**
 * Tests for source-check orchestrator routing — verifies that record-type
 * subcommands (e.g., `tb verify personnel`) correctly pass the `table` filter
 * to the orchestrator.
 *
 * Regression test for the routing bug where `mapped` was computed but not
 * passed as `table` in options, causing `tb verify personnel` to verify
 * ALL record types instead of just personnel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock orchestrateCommand to capture the options it receives
const mockOrchestrateCommand = vi.fn().mockResolvedValue({ exitCode: 0, output: 'ok' });

vi.mock('../../lib/source-check/orchestrator.ts', () => ({
  orchestrateCommand: (...args: unknown[]) => mockOrchestrateCommand(...args),
}));

// Mock getVerificationStats (used by stats subcommand)
vi.mock('../../lib/wiki-server/verifications.ts', () => ({
  getVerificationStats: vi.fn().mockResolvedValue({
    ok: true,
    data: { total: 0, avg_confidence: 0, needs_recheck: 0, by_verdict: {}, by_type: {} },
  }),
}));

// Import after mocks are set up
const { commands } = await import('../source-check-orchestrate.ts');

describe('verify subcommand routing', () => {
  beforeEach(() => {
    mockOrchestrateCommand.mockClear();
  });

  it('tb verify personnel passes table=personnel to orchestrator', async () => {
    await commands.default(['personnel'], {});

    expect(mockOrchestrateCommand).toHaveBeenCalledOnce();
    const [args, options] = mockOrchestrateCommand.mock.calls[0];
    expect(options.type).toBe('record');
    expect(options.table).toBe('personnel');
    expect(args).toEqual([]); // subcommand is stripped
  });

  it('tb verify grants passes table=grant to orchestrator', async () => {
    await commands.default(['grants'], {});

    expect(mockOrchestrateCommand).toHaveBeenCalledOnce();
    const [, options] = mockOrchestrateCommand.mock.calls[0];
    expect(options.type).toBe('record');
    expect(options.table).toBe('grant');
  });

  it('tb verify investments passes table=investment to orchestrator', async () => {
    await commands.default(['investments'], {});

    expect(mockOrchestrateCommand).toHaveBeenCalledOnce();
    const [, options] = mockOrchestrateCommand.mock.calls[0];
    expect(options.type).toBe('record');
    expect(options.table).toBe('investment');
  });

  it('tb verify funding-rounds passes table=funding-round to orchestrator', async () => {
    await commands.default(['funding-rounds'], {});

    expect(mockOrchestrateCommand).toHaveBeenCalledOnce();
    const [, options] = mockOrchestrateCommand.mock.calls[0];
    expect(options.type).toBe('record');
    expect(options.table).toBe('funding-round');
  });

  it('tb verify benchmark-results passes table=benchmark-result to orchestrator', async () => {
    await commands.default(['benchmark-results'], {});

    expect(mockOrchestrateCommand).toHaveBeenCalledOnce();
    const [, options] = mockOrchestrateCommand.mock.calls[0];
    expect(options.type).toBe('record');
    expect(options.table).toBe('benchmark-result');
  });

  it('preserves existing options alongside table filter', async () => {
    await commands.default(['personnel', '--dry-run'], { 'dry-run': true, limit: '50' });

    expect(mockOrchestrateCommand).toHaveBeenCalledOnce();
    const [, options] = mockOrchestrateCommand.mock.calls[0];
    expect(options.type).toBe('record');
    expect(options.table).toBe('personnel');
    expect(options['dry-run']).toBe(true);
    expect(options.limit).toBe('50');
  });

  it('tb verify without subcommand calls orchestrate with original args', async () => {
    await commands.default([], { type: 'fact' });

    expect(mockOrchestrateCommand).toHaveBeenCalledOnce();
    const [args, options] = mockOrchestrateCommand.mock.calls[0];
    expect(args).toEqual([]);
    expect(options.type).toBe('fact');
    expect(options.table).toBeUndefined();
  });

  it('tb verify orchestrate subcommand calls orchestrate directly', async () => {
    await commands.default(['orchestrate', '--limit=10'], { limit: '10' });

    expect(mockOrchestrateCommand).toHaveBeenCalledOnce();
    const [args, options] = mockOrchestrateCommand.mock.calls[0];
    expect(args).toEqual(['--limit=10']);
    expect(options.table).toBeUndefined();
  });

  // Singular forms should also work
  it('tb verify grant (singular) maps to table=grant', async () => {
    await commands.default(['grant'], {});

    expect(mockOrchestrateCommand).toHaveBeenCalledOnce();
    const [, options] = mockOrchestrateCommand.mock.calls[0];
    expect(options.table).toBe('grant');
  });

  it('tb verify division (singular) maps to table=division', async () => {
    await commands.default(['division'], {});

    expect(mockOrchestrateCommand).toHaveBeenCalledOnce();
    const [, options] = mockOrchestrateCommand.mock.calls[0];
    expect(options.table).toBe('division');
  });
});
