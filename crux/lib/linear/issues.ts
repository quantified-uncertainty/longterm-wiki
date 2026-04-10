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
 */
export async function getComments(
  identifier: string,
  limit = 20,
): Promise<LinearComment[]> {
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

/** Convenience re-export so callers import everything from one module. */
export { linearIssueUrl };
