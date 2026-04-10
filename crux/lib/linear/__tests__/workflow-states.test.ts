import { describe, it, expect } from 'vitest';
import {
  QUA_WORKFLOW_STATES,
  getWorkflowStateId,
  type WorkflowStateName,
} from '../workflow-states.ts';

describe('QUA_WORKFLOW_STATES', () => {
  it('has entries for every canonical state', () => {
    const expected: WorkflowStateName[] = [
      'Backlog',
      'Todo',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
      'Duplicate',
    ];
    for (const name of expected) {
      expect(QUA_WORKFLOW_STATES[name]).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('has no duplicate UUIDs across states', () => {
    const ids = Object.values(QUA_WORKFLOW_STATES);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getWorkflowStateId', () => {
  it('resolves known state names to their UUIDs', () => {
    expect(getWorkflowStateId('In Progress')).toBe(
      QUA_WORKFLOW_STATES['In Progress']
    );
    expect(getWorkflowStateId('Done')).toBe(QUA_WORKFLOW_STATES.Done);
  });

  it('throws on an unknown state name', () => {
    expect(() =>
      // @ts-expect-error — intentionally passing an invalid name
      getWorkflowStateId('Doing')
    ).toThrow(/Unknown Linear workflow state/);
  });
});
