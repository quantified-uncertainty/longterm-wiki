/**
 * Prompt templates for resource classification and enrichment.
 */

export const CLASSIFICATION_SYSTEM = `You are a resource classifier for an AI safety wiki. Classify each resource based on its URL, title, and content snippet.

Respond with valid JSON only. No markdown formatting, no code blocks.`;

export function classificationPrompt(resource: {
  id: string;
  url: string;
  title: string | null;
  type: string | null;
  content_snippet: string | null;
}): string {
  return `Classify this resource:

URL: ${resource.url}
Title: ${resource.title || '(none)'}
Current type: ${resource.type || '(none)'}
Content preview: ${resource.content_snippet || '(none)'}

Return JSON with these fields:
{
  "resource_subtype": one of: "arxiv_preprint", "journal_article", "conference_paper", "working_paper", "blog_post", "news_article", "organizational_report", "policy_brief", "executive_order", "legislation", "regulation", "guidance_document", "standard", "book_chapter", "book", "video", "podcast_episode", "dataset", "tool_page", "documentation", "wiki_page", "homepage", "press_release", "opinion_piece", "interview", "other",
  "resource_purpose": one of: "primary_source", "commentary", "analysis", "reference", "tool", "dataset", "homepage", "news", "educational",
  "context_note": a single sentence explaining what this resource is and why it matters for AI safety (max 100 words),
  "sub_table": one of: "paper", "forum_post", "policy_doc", "none" — which sub-table this resource belongs to
}`;
}

export const ENRICHMENT_SYSTEM = `You are an expert analyst enriching metadata for an AI safety knowledge base. Analyze each resource and provide structured metadata.

Respond with valid JSON only. No markdown formatting, no code blocks.`;

export function enrichmentPrompt(resource: {
  id: string;
  url: string;
  title: string | null;
  type: string | null;
  summary: string | null;
  content: string | null;
  existing_tags: string[] | null;
}): string {
  return `Analyze this resource and provide enriched metadata:

URL: ${resource.url}
Title: ${resource.title || '(none)'}
Type: ${resource.type || '(none)'}
Current summary: ${resource.summary || '(none)'}
Content (first 4000 chars): ${resource.content?.slice(0, 4000) || '(none)'}
Current tags: ${resource.existing_tags?.join(', ') || '(none)'}

Return JSON:
{
  "clean_title": improved title if current one is truncated/bad, else null,
  "summary": 1-3 sentence summary of the resource's key contribution,
  "key_points": array of 3-5 bullet points (strings, each max 200 chars),
  "tags": array of relevant tags (max 10, use existing wiki tag vocabulary: ai-safety, alignment, governance, interpretability, capabilities, existential-risk, policy, technical-safety, coordination, compute, deployment, evaluation, red-teaming, etc.),
  "importance_score": integer 0-100 where 100 = foundational paper everyone should read, 50 = useful reference, 10 = tangential,
  "resource_purpose": one of "primary_source", "commentary", "analysis", "reference", "tool", "dataset", "homepage", "news", "educational",
  "context_note": single sentence of context for wiki users (max 100 words)
}`;
}
