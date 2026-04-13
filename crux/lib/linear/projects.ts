/**
 * Typed helpers for Linear Project operations.
 *
 * Projects group related issues in Linear. This module lets `crux linear project`
 * commands list, view, update, and post updates to projects — mirroring the
 * patterns in `issues.ts` for QUA-NNN operations.
 *
 * Lookup semantics: all operations that take a "project ref" accept either a
 * UUID (e.g. `6f9c8f44-7d33-4573-a017-a2200b8b22da`) or a case-insensitive
 * exact name match (e.g. `Content Quality & Enrichment`). UUIDs are checked
 * first so name collisions with UUID-shaped strings can't occur.
 */

import { linearGraphQL, LINEAR_WORKSPACE_SLUG } from './client.ts';
import { QUA_TEAM_ID } from './workflow-states.ts';

export interface LinearProject {
  id: string;
  name: string;
  /** Short summary — the "description" field in Linear's UI. */
  description: string | null;
  /** Long-form markdown body — the "content" field in Linear's UI (what you edit in the project page). */
  content: string | null;
  state: string;
  progress: number;
  startDate: string | null;
  targetDate: string | null;
  url: string;
  updatedAt: string;
  lead: { id: string; name: string } | null;
}

const PROJECT_FIELDS = `
  id name description content state progress
  startDate targetDate url updatedAt
  lead { id name }
`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** List every project accessible from the QUA team. */
export async function listProjects(): Promise<LinearProject[]> {
  const data = await linearGraphQL<{ projects: { nodes: LinearProject[] } }>(
    `query Projects { projects(first: 100, filter: { accessibleTeams: { id: { eq: "${QUA_TEAM_ID}" } } }) { nodes { ${PROJECT_FIELDS} } } }`,
    {},
  );
  return data.projects.nodes;
}

/**
 * Resolve a project by UUID or exact name. Returns null if not found.
 *
 * Names are matched case-insensitively but must be exact — we don't do
 * substring matching because projects often share words ("Source-Check &
 * Verification" vs a hypothetical "Source Audit") and the wrong match is
 * worse than a miss.
 */
export async function getProject(ref: string): Promise<LinearProject | null> {
  if (isUuid(ref)) {
    try {
      const data = await linearGraphQL<{ project: LinearProject | null }>(
        `query P($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`,
        { id: ref },
      );
      return data.project ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Entity not found|EntityNotFound/i.test(msg)) return null;
      throw e;
    }
  }

  // Name lookup — fetch all and match case-insensitively.
  const all = await listProjects();
  const needle = ref.toLowerCase();
  return all.find((p) => p.name.toLowerCase() === needle) ?? null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  content?: string;
  state?: string;
  startDate?: string;
  targetDate?: string;
}

/**
 * Update a project. Any omitted field is left unchanged.
 *
 * Note: Linear's `description` is a short one-line summary (shown in cards);
 * `content` is the long-form markdown body rendered on the project page. You
 * almost always want to update `content`, not `description`.
 */
export async function updateProject(
  id: string,
  input: UpdateProjectInput,
): Promise<LinearProject> {
  if (!isUuid(id)) {
    throw new Error(`updateProject: expected UUID, got "${id}". Call getProject() first to resolve a name.`);
  }
  const data = await linearGraphQL<{
    projectUpdate: { success: boolean; project: LinearProject };
  }>(
    `mutation U($id: String!, $input: ProjectUpdateInput!) {
      projectUpdate(id: $id, input: $input) {
        success
        project { ${PROJECT_FIELDS} }
      }
    }`,
    { id, input },
  );
  if (!data.projectUpdate.success) {
    throw new Error(`Linear refused to update project ${id}`);
  }
  return data.projectUpdate.project;
}

/**
 * Post a project update (Linear's equivalent of a comment on a project).
 *
 * Project updates are the status posts you see in the project timeline — they
 * support markdown and are the right place to announce milestones or log
 * audit passes.
 */
export async function createProjectUpdate(
  id: string,
  body: string,
): Promise<void> {
  if (!isUuid(id)) {
    throw new Error(`createProjectUpdate: expected UUID, got "${id}". Call getProject() first to resolve a name.`);
  }
  const data = await linearGraphQL<{ projectUpdateCreate: { success: boolean } }>(
    `mutation U($input: ProjectUpdateCreateInput!) {
      projectUpdateCreate(input: $input) { success }
    }`,
    { input: { projectId: id, body } },
  );
  if (!data.projectUpdateCreate.success) {
    throw new Error(`Linear refused to create project update on ${id}`);
  }
}

/** Build a Linear project URL for display (the API already returns `url` but this is a convenience for constructed references). */
export function linearProjectUrl(slug: string): string {
  return `https://linear.app/${LINEAR_WORKSPACE_SLUG}/project/${slug}`;
}
