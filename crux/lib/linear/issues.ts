/**
 * Typed helpers for Linear issue operations used by agent skills.
 *
 * These wrap `linearGraphQL()` with the minimal shape each caller needs, so
 * bash skills never touch GraphQL directly. Following the `crux/lib/github.ts`
 * pattern: narrow typed functions over a generic transport.
 */

import { linearGraphQL, linearIssueUrl } from './client.ts';
import {
  getWorkflowStateId,
  QUA_TEAM_ID,
  type WorkflowStateName,
} from './workflow-states.ts';

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  url: string;
  state: { id: string; name: string; type: string };
  team: { id: string; key: string };
  parent: { identifier: string; title: string } | null;
  project: { id: string; name: string } | null;
  labels: { nodes: Array<{ name: string }> };
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  user: { name: string } | null;
}

/**
 * Fetch a single issue by identifier (e.g. "QUA-184").
 * Returns null if the issue doesn't exist.
 */
export async function getIssue(identifier: string): Promise<LinearIssue | null> {
  try {
    const data = await linearGraphQL<{ issue: LinearIssue | null }>(
      `query GetIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          priority
          url
          state { id name type }
          team { id key }
          parent { identifier title }
          project { id name }
          labels { nodes { name } }
        }
      }`,
      { id: identifier },
    );
    return data.issue ?? null;
  } catch (e) {
    // Linear returns an error rather than null for missing issues; re-throw unless it's a not-found
    const msg = e instanceof Error ? e.message : String(e);
    if (/Entity not found|EntityNotFound/i.test(msg)) return null;
    throw e;
  }
}

/**
 * Fetch recent comments on an issue. Returns comments in creation order.
 * Returns an empty array if the issue doesn't exist (same missing-issue
 * semantics as `getIssue()`).
 */
export async function getComments(
  identifier: string,
  limit = 20,
): Promise<LinearComment[]> {
  try {
    const data = await linearGraphQL<{
      issue: { comments: { nodes: LinearComment[] } } | null;
    }>(
      `query GetComments($id: String!, $limit: Int!) {
        issue(id: $id) {
          comments(first: $limit) {
            nodes { id body createdAt user { name } }
          }
        }
      }`,
      { id: identifier, limit },
    );
    return data.issue?.comments.nodes ?? [];
  } catch (e) {
    // Mirror getIssue()'s missing-issue handling: Linear returns an error
    // rather than null when the issue identifier doesn't exist.
    const msg = e instanceof Error ? e.message : String(e);
    if (/Entity not found|EntityNotFound/i.test(msg)) return [];
    throw e;
  }
}

/**
 * Update an issue's workflow state.
 *
 * Accepts the canonical state name (e.g. "In Progress") and resolves it to
 * the team-scoped state UUID via the shared constants. This keeps the UUIDs
 * in one place — skills pass names, not IDs.
 */
export async function updateIssueState(
  identifier: string,
  state: WorkflowStateName,
): Promise<{ identifier: string; state: string }> {
  const stateId = getWorkflowStateId(state);
  const data = await linearGraphQL<{
    issueUpdate: {
      success: boolean;
      issue: { identifier: string; state: { name: string } };
    };
  }>(
    `mutation UpdateState($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
        issue { identifier state { name } }
      }
    }`,
    { id: identifier, stateId },
  );
  if (!data.issueUpdate.success) {
    throw new Error(`Linear refused to update ${identifier} to ${state}`);
  }
  return {
    identifier: data.issueUpdate.issue.identifier,
    state: data.issueUpdate.issue.state.name,
  };
}

/** Add a comment to an existing issue. */
export async function commentOnIssue(
  identifier: string,
  body: string,
): Promise<void> {
  // Comment mutations need the issue's UUID, not the QUA-NNN identifier.
  const issue = await getIssue(identifier);
  if (!issue) throw new Error(`Linear issue ${identifier} not found`);
  const data = await linearGraphQL<{ commentCreate: { success: boolean } }>(
    `mutation Comment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    { input: { issueId: issue.id, body } },
  );
  if (!data.commentCreate.success) {
    throw new Error(`Linear refused to post comment on ${identifier}`);
  }
}

export interface CreateIssueInput {
  title: string;
  description: string;
  priority?: number;
  parentId?: string;
  projectId?: string;
  teamId?: string;
}

/** Create a new Linear issue. Defaults to the QUA team when `teamId` is omitted. */
export async function createIssue(
  input: CreateIssueInput,
): Promise<{ identifier: string; url: string }> {
  const data = await linearGraphQL<{
    issueCreate: {
      success: boolean;
      issue: { identifier: string; url: string };
    };
  }>(
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { identifier url }
      }
    }`,
    {
      input: {
        teamId: input.teamId ?? QUA_TEAM_ID,
        title: input.title,
        description: input.description,
        priority: input.priority,
        parentId: input.parentId,
        projectId: input.projectId,
      },
    },
  );
  if (!data.issueCreate.success) {
    throw new Error(`Linear refused to create issue "${input.title}"`);
  }
  return data.issueCreate.issue;
}

export interface SearchedIssue {
  identifier: string;
  title: string;
  priority: number;
  state: { name: string; type: string };
  url: string;
}

/**
 * Search issues by free-text query. Uses Linear's built-in `searchIssues`.
 * Results are limited to the QUA team by default.
 */
export async function searchIssues(
  query: string,
  limit = 20,
  teamId: string = QUA_TEAM_ID,
): Promise<SearchedIssue[]> {
  const data = await linearGraphQL<{
    searchIssues: { nodes: SearchedIssue[] };
  }>(
    `query Search($q: String!, $limit: Int!, $filter: IssueFilter) {
      searchIssues(term: $q, first: $limit, filter: $filter) {
        nodes {
          identifier
          title
          priority
          state { name type }
          url
        }
      }
    }`,
    {
      q: query,
      limit,
      filter: { team: { id: { eq: teamId } } },
    },
  );
  return data.searchIssues.nodes;
}

// ---------------------------------------------------------------------------
// List by state type (for triage/maintenance)
// ---------------------------------------------------------------------------

/**
 * Fetch issues filtered by workflow state type(s).
 */
export async function listIssuesByStateType(
  stateTypes: string[],
  limit = 50,
  teamId: string = QUA_TEAM_ID,
): Promise<LinearTriageIssue[]> {
  const data = await linearGraphQL<{
    issues: { nodes: LinearTriageIssue[] };
  }>(
    `query IssuesByState($filter: IssueFilter!, $limit: Int!) {
      issues(filter: $filter, first: $limit, orderBy: updatedAt) {
        nodes {
          identifier
          title
          priority
          updatedAt
          state { name type }
          assignee { name }
          parent { identifier title }
          project { name }
          labels { nodes { name } }
        }
      }
    }`,
    {
      filter: {
        team: { id: { eq: teamId } },
        state: { type: { in: stateTypes } },
      },
      limit,
    },
  );
  return data.issues.nodes;
}

export interface LinearTriageIssue {
  identifier: string;
  title: string;
  priority: number;
  updatedAt: string;
  state: { name: string; type: string };
  assignee: { name: string } | null;
  parent: { identifier: string; title: string } | null;
  project: { name: string } | null;
  labels: { nodes: Array<{ name: string }> };
}

// ---------------------------------------------------------------------------
// Children / parent-epic detection
// ---------------------------------------------------------------------------

export interface LinearChildIssue {
  identifier: string;
  title: string;
  state: { name: string; type: string };
}

/**
 * Fetch direct children (sub-issues) of a single Linear issue.
 *
 * Used by the audit command to detect parent epics whose sub-issues have
 * all resolved — the parent can be closed but typically isn't linked to a
 * PR, so Linear's GitHub integration won't auto-close it.
 */
export async function getIssueChildren(
  identifier: string,
): Promise<LinearChildIssue[]> {
  try {
    const data = await linearGraphQL<{
      issue: { children: { nodes: LinearChildIssue[] } } | null;
    }>(
      `query Children($id: String!) {
        issue(id: $id) {
          children(first: 50) {
            nodes {
              identifier
              title
              state { name type }
            }
          }
        }
      }`,
      { id: identifier },
    );
    return data.issue?.children.nodes ?? [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Entity not found|EntityNotFound/i.test(msg)) return [];
    throw e;
  }
}

// ---------------------------------------------------------------------------
// List ready issues (for "next issue" picking)
// ---------------------------------------------------------------------------

export interface ReadyIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number; // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  url: string;
  createdAt: string;
  updatedAt: string;
  state: { name: string; type: string };
  assignee: { name: string } | null;
  labels: { nodes: Array<{ name: string }> };
  parent: { identifier: string; title: string } | null;
  project: { id: string; name: string } | null;
}

/**
 * Fetch issues in "ready" states (Todo, Backlog) from the QUA team.
 * Returns issues sorted by Linear's priority (urgent first), then by
 * creation date (oldest first within the same priority).
 *
 * Excludes issues that are In Progress, In Review, Done, Canceled, or Duplicate.
 */
export async function listReadyIssues(
  limit = 50,
  teamId: string = QUA_TEAM_ID,
): Promise<ReadyIssue[]> {
  const data = await linearGraphQL<{
    issues: { nodes: ReadyIssue[] };
  }>(
    `query ReadyIssues($limit: Int!, $filter: IssueFilter) {
      issues(
        first: $limit
        filter: $filter
        orderBy: createdAt
      ) {
        nodes {
          id
          identifier
          title
          description
          priority
          url
          createdAt
          updatedAt
          state { name type }
          assignee { name }
          labels { nodes { name } }
          parent { identifier title }
          project { id name }
        }
      }
    }`,
    {
      limit,
      filter: {
        team: { id: { eq: teamId } },
        state: {
          type: { in: ['backlog', 'unstarted'] }, // backlog = Backlog, unstarted = Todo
        },
      },
    },
  );
  return data.issues.nodes;
}

// ---------------------------------------------------------------------------
// Scoring (mirrors crux/lib/issues/scoring.ts patterns for Linear)
// ---------------------------------------------------------------------------

/**
 * Score a Linear issue for agent dispatch ordering.
 *
 * Linear priorities: 1=urgent, 2=high, 3=medium, 4=low, 0=none.
 * Higher score = should be worked on first.
 */
export function scoreLinearIssue(issue: ReadyIssue): number {
  // Base score from Linear's built-in priority
  const priorityScores: Record<number, number> = {
    1: 1000, // urgent
    2: 500,  // high
    3: 200,  // medium
    4: 100,  // low
    0: 50,   // none
  };
  let score = priorityScores[issue.priority] ?? 50;

  // Bug/fix bonus
  const labelNames = issue.labels.nodes.map((l) => l.name.toLowerCase());
  if (labelNames.some((l) => ['bug', 'defect', 'regression', 'fix', 'crash'].includes(l))) {
    score += 50;
  }

  // Agent-ready label bonus (1.5x)
  if (labelNames.some((l) => ['claude-ready', 'agent-ready', 'agent:ready'].includes(l))) {
    score = Math.round(score * 1.5);
  }

  // Recency bonus: updated in last 7 days = someone cares
  const updatedMs = Date.now() - new Date(issue.updatedAt).getTime();
  if (updatedMs < 7 * 24 * 60 * 60 * 1000) {
    score += 15;
  }

  // Age bonus: +1 per month, capped at +10 (prevent starvation)
  const ageMs = Date.now() - new Date(issue.createdAt).getTime();
  const ageMonths = Math.floor(ageMs / (30 * 24 * 60 * 60 * 1000));
  score += Math.min(ageMonths, 10);

  return score;
}

/** Labels that signal an issue should be skipped. */
const SKIP_LABELS = new Set([
  'wontfix', "won't fix", 'on-hold', 'invalid', 'duplicate',
  'blocked', 'waiting', 'needs-info', 'needs-discussion',
]);

/**
 * Check if a Linear issue should be skipped by the auto-picker.
 */
export function isLinearIssueBlocked(issue: ReadyIssue): boolean {
  const labelNames = issue.labels.nodes.map((l) => l.name.toLowerCase());
  if (labelNames.some((l) => SKIP_LABELS.has(l))) return true;

  // Check description for blocking language
  if (issue.description) {
    if (/\bblocked by\b/i.test(issue.description)) return true;
    if (/\bwaiting (for|on)\b/i.test(issue.description)) return true;
    if (/\bdepends on\b/i.test(issue.description)) return true;
  }

  return false;
}

/**
 * Rank ready issues: score descending, then oldest first as tiebreaker.
 */
export function rankReadyIssues(issues: ReadyIssue[]): Array<ReadyIssue & { score: number; blocked: boolean }> {
  return issues
    .map((issue) => ({
      ...issue,
      score: scoreLinearIssue(issue),
      blocked: isLinearIssueBlocked(issue),
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
}

/** Convenience re-export so callers import everything from one module. */
export { linearIssueUrl };
