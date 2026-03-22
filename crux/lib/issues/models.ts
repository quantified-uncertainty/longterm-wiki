/**
 * Model extraction and GitHub label management for issue model recommendations.
 */

import type { ModelName } from './types.ts';
import type { GitHubLabelResponse } from './types.ts';
import {
  MODEL_NAMES,
  MODEL_LABEL_PREFIX,
  MODEL_LABEL_COLORS,
  MODEL_LABEL_DESCS,
} from './types.ts';
import { githubApi, REPO } from '../github.ts';

/**
 * Extract recommended model from labels, issue title, or body (in priority order).
 * Looks for:
 *   - Labels: model:haiku, model:sonnet, model:opus (primary — machine-readable)
 *   - Body: "## Recommended Model" section header + model name (legacy)
 *   - Title: [haiku], [sonnet], [opus] suffix (legacy)
 */
export function extractModel(title: string, body: string, labels: string[] = []): ModelName | null {
  // Check labels first: model:haiku, model:sonnet, model:opus
  for (const label of labels) {
    const m = label.match(/^model:(haiku|sonnet|opus)$/i);
    if (m) return m[1].toLowerCase() as ModelName;
  }

  // Check body: look for "## Recommended Model" section header + model name
  // Handles blank lines between header and value (e.g., "## Recommended Model\n\n**Sonnet**...")
  const sectionMatch = body.match(/##\s+recommended\s+model[^\n]*\n[\s\S]{0,10}?(haiku|sonnet|opus)/i);
  if (sectionMatch) return sectionMatch[1].toLowerCase() as ModelName;

  // Check title: [haiku], [sonnet], [opus]
  const titleMatch = title.match(/\[(haiku|sonnet|opus)\]/i);
  if (titleMatch) return titleMatch[1].toLowerCase() as ModelName;

  return null;
}

/** Ensure model:X GitHub label exists, then apply it to an issue (replacing any existing model label). */
export async function applyModelLabel(issueNum: number, model: ModelName, existingLabels: string[]): Promise<void> {
  const labelName = `${MODEL_LABEL_PREFIX}${model}`;

  // Ensure label exists in repo
  try {
    await githubApi<GitHubLabelResponse>(`/repos/${REPO}/labels/${encodeURIComponent(labelName)}`);
  } catch {
    await githubApi(`/repos/${REPO}/labels`, {
      method: 'POST',
      body: { name: labelName, color: MODEL_LABEL_COLORS[model], description: MODEL_LABEL_DESCS[model] },
    });
  }

  // Remove any existing model:X labels on this issue
  for (const l of existingLabels) {
    if (l.startsWith(MODEL_LABEL_PREFIX) && l !== labelName) {
      await githubApi(`/repos/${REPO}/issues/${issueNum}/labels/${encodeURIComponent(l)}`, { method: 'DELETE' });
    }
  }

  // Apply the new label (no-op if already present)
  if (!existingLabels.includes(labelName)) {
    await githubApi(`/repos/${REPO}/issues/${issueNum}/labels`, {
      method: 'POST',
      body: { labels: [labelName] },
    });
  }
}

/** Validate a model name string. Returns true if valid. */
export function isValidModel(model: string): boolean {
  return (MODEL_NAMES as ReadonlyArray<string>).includes(model.toLowerCase());
}
