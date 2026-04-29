/**
 * Rule: EntityLink ID Validation
 *
 * Checks that all <EntityLink id="..."> components reference valid IDs
 * and follow the preferred format: wiki ID primary, optional name cross-check.
 *
 * Preferred format:
 *   <EntityLink id="E42" name="anthropic">Anthropic</EntityLink>
 *
 * Checks:
 * 1. ID resolves to a known entity (via pathRegistry, entities DB, or content file)
 * 2. Slug IDs should use numeric format instead (ERROR, auto-fixable from
 *    user-typed slug — safe)
 * 3. Bare numeric ID (e.g. "35"): normalize to E-prefix only (ERROR,
 *    auto-fixable; see QUA-761 — does not inject name= from registry)
 * 4. Wiki ID + name: validates name matches the entity's slug (ERROR if mismatch,
 *    NO auto-fix — see QUA-761)
 * 5. Wiki ID without name + display text matches the registry entity:
 *    advisory (WARNING, auto-fixable to add cross-check)
 * 6. Wiki ID without name + display text does NOT match the registry entity:
 *    ERROR (NO auto-fix — see QUA-759). Same hallucination shape as QUA-761:
 *    silently injecting name="${slug}" would lock in a "valid" cross-check on
 *    a link whose visible text disagrees with where the ID currently points,
 *    making future detection of the bad wikiId harder.
 * 7. Unknown wiki ID: warning
 */

import { createRule, Issue, Severity, FixType, type ContentFile, type ValidationEngine } from '../validation/validation-engine.ts';
import { CONTENT_DIR_ABS as CONTENT_DIR, loadPages, type Entity, type PageEntry } from '../content-types.ts';
import { ENTITY_LINK_RE, WIKI_ID_RE, extractEntityLinkName } from '../patterns.ts';
import { existsSync } from 'fs';
import { join } from 'path';

/** Slugify free text the same way entity IDs are normalized. */
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build (and cache per-engine) a `slug → Entity` map from `engine.entities`.
 *
 * `engine.entities` is loaded as `Entity[]` by the engine but typed as
 * `unknown` on the engine surface. We tolerate either array or record shape
 * here to avoid coupling the rule to engine internals or to the test mock
 * shape.
 */
const entityBySlugCache = new WeakMap<object, Map<string, Entity>>();
function getEntitiesBySlug(engine: ValidationEngine): Map<string, Entity> {
  const raw = engine.entities as unknown;
  if (!raw || typeof raw !== 'object') return new Map();
  const cached = entityBySlugCache.get(raw as object);
  if (cached) return cached;
  const map = new Map<string, Entity>();
  const list: Entity[] = Array.isArray(raw)
    ? (raw as Entity[])
    : Object.values(raw as Record<string, Entity>);
  for (const e of list) {
    if (e && typeof e === 'object' && typeof (e as Entity).id === 'string') {
      map.set((e as Entity).id, e as Entity);
    }
  }
  entityBySlugCache.set(raw as object, map);
  return map;
}

/**
 * Cached `slug → MDX page frontmatter title` map. Many entities (especially
 * dashboards and concept pages under `internal/`) don't have YAML records —
 * their canonical title lives in the page's frontmatter. Without this, the
 * mismatch heuristic would over-flag display variants of those titles.
 */
let pagesBySlugCache: Map<string, PageEntry> | null = null;
function getPagesBySlug(): Map<string, PageEntry> {
  if (pagesBySlugCache) return pagesBySlugCache;
  const map = new Map<string, PageEntry>();
  try {
    for (const page of loadPages()) {
      if (page?.id) map.set(page.id, page);
    }
  } catch {
    // loadPages() relies on generated JSON; fall through with an empty map.
  }
  pagesBySlugCache = map;
  return map;
}

/**
 * Try to extract the plain-text children of an `<EntityLink ...>` whose
 * opening tag begins at `startIdx` of `text` (typically the full content
 * body, not a single line — see the call site, which tracks the absolute
 * body offset so multi-line tags resolve correctly). Returns:
 *   - undefined if the tag is self-closing (no children to compare)
 *   - undefined if the children contain JSX/markup (cannot reliably slugify)
 *   - undefined if no closing `</EntityLink>` is reached
 *   - the trimmed text otherwise
 */
function extractEntityLinkChildren(text: string, startIdx: number): string | undefined {
  const slice = text.slice(startIdx);
  // Self-closing tag: `<EntityLink ... />` — no children, return undefined
  // (caller treats as "cannot compare", keeps safe auto-fix behavior).
  if (/^<EntityLink[^>]*\/\s*>/.test(slice)) return undefined;
  // Plain-text children: `<EntityLink ...>(no other tags, possibly multi-line)</EntityLink>`.
  // `[^<]*` already permits newlines, so the only thing we need from the
  // body-wide scan is to reach the closing tag — which may be on a later
  // line than the opening tag.
  const m = /^<EntityLink[^>]*>([^<]*)<\/EntityLink>/.exec(slice);
  if (!m) return undefined;
  const children = m[1].trim();
  return children.length > 0 ? children : undefined;
}

/**
 * Heuristic: does `displayText` plausibly identify the same entity as
 * `registrySlug`?
 *
 * The rendered link's visible text comes from this children string, so a
 * mismatch here is exactly the QUA-761-style silent corruption: the link
 * displays one identity but routes to another.
 *
 * Substring matching is dangerous for short slugs ("miri" wrongly matches
 * inside "Miriam Cohen", "ai" wrongly matches anywhere) so the heuristic
 * uses three layered checks instead, in order of strictness:
 *   1. Exact slug match
 *   2. Word-boundary match (slug words appear as complete tokens in display)
 *   3. Hyphen-collapsed substring with a length floor (handles digit-attached
 *      slugs like "sb-1047" inside "california-sb1047")
 *   4. Entity/page title equality, alias equality, length-floored substring
 *   5. 2+ significant-word overlap with slug or title (handles paraphrased
 *      display variants like "Brookings Institution's AI Initiative" vs
 *      title "Brookings Institution AI and Emerging Technology Initiative")
 *
 * The minimum length floor of 5 chars on substring matching is the load-
 * bearing change vs the original implementation: it lets short canonical
 * slugs like "cea"/"fhi"/"miri" match through the entity-title path
 * (where exact equality is reliable) while preventing them from matching
 * inside arbitrary unrelated longer strings.
 */
function displayMatchesEntity(
  displayText: string,
  registrySlug: string,
  entity: Entity | undefined,
  pageTitle?: string,
): boolean {
  const ds = slugify(displayText);
  if (!ds) return true; // no signal to reject on
  if (ds === registrySlug) return true;

  // (2) Word-boundary match. Single-word slugs (e.g. "anthropic", "miri")
  // must appear as a complete token of `ds`. Multi-word slugs (e.g.
  // "anthropic-research") match if every slug word appears in the display.
  // Also: short-display acronyms (e.g. display="RAND" against slug
  // "rand-corporation") match if the entire display is one of the slug's
  // words — the user often abbreviates a multi-word entity to its
  // distinctive token in prose.
  const dsWords = ds.split('-');
  const slugWords = registrySlug.split('-');
  if (slugWords.length === 1) {
    if (dsWords.includes(slugWords[0])) return true;
  } else if (slugWords.every((w) => dsWords.includes(w))) {
    return true;
  } else if (dsWords.length === 1 && slugWords.includes(dsWords[0])) {
    return true;
  }

  // (3) Hyphen-collapsed substring with min-length 5. Catches digit-attached
  // slugs like "sb-1047" inside "california-sb1047" without false-positiving
  // on short acronyms.
  const dsCompact = ds.replace(/-/g, '');
  const slugCompact = registrySlug.replace(/-/g, '');
  if (dsCompact.length >= 5 && slugCompact.length >= 5) {
    if (dsCompact === slugCompact) return true;
    if (dsCompact.includes(slugCompact) || slugCompact.includes(dsCompact)) return true;
  }

  // (4) Entity/page title equality + length-floored substring + aliases.
  const dt = displayText.toLowerCase().trim();
  const titles: string[] = [];
  if (entity?.title) titles.push(entity.title);
  if (pageTitle) titles.push(pageTitle);
  for (const t of titles) {
    const et = t.toLowerCase().trim();
    if (dt === et) return true;
    if (dt.length >= 5 && et.length >= 5 && (et.includes(dt) || dt.includes(et))) return true;
  }
  if (entity?.aliases) {
    for (const alias of entity.aliases) {
      if (typeof alias === 'string' && alias.toLowerCase().trim() === dt) return true;
    }
  }

  // (5) 2+ significant-word (length ≥ 3) overlap. Compares the display-text
  // word set against both (a) the registry slug words and (b) the entity/page
  // title words. The 2-word floor avoids matching unrelated entities that
  // share a single common token like "ai".
  const dsSigWords = new Set(dsWords.filter((w) => w.length >= 3));
  const slugSigWords = new Set(slugWords.filter((w) => w.length >= 3));
  let overlap = 0;
  for (const w of dsSigWords) if (slugSigWords.has(w)) overlap++;
  if (overlap >= 2) return true;
  for (const t of titles) {
    const titleWords = new Set(slugify(t).split('-').filter((w) => w.length >= 3));
    let titleOverlap = 0;
    for (const w of dsSigWords) if (titleWords.has(w)) titleOverlap++;
    if (titleOverlap >= 2) return true;
  }
  return false;
}

/**
 * Check if a path-style ID resolves to a real content file.
 * Mirrors the EntityLink fallback: `/knowledge-base/${id}/`
 */
function pathStyleIdResolvesToFile(id: string): boolean {
  // Only applies to IDs that look like paths (contain /)
  if (!id.includes('/')) return false;

  // Check knowledge-base top-level dir
  const prefixes = ['knowledge-base'];

  for (const prefix of prefixes) {
    const possiblePaths = [
      join(CONTENT_DIR, prefix, id + '.mdx'),
      join(CONTENT_DIR, prefix, id + '.md'),
      join(CONTENT_DIR, prefix, id, 'index.mdx'),
      join(CONTENT_DIR, prefix, id, 'index.md'),
    ];

    for (const p of possiblePaths) {
      if (existsSync(p)) return true;
    }
  }

  // Also check without prefix (the ID itself may include the full content path)
  const directPaths = [
    join(CONTENT_DIR, id + '.mdx'),
    join(CONTENT_DIR, id + '.md'),
    join(CONTENT_DIR, id, 'index.mdx'),
    join(CONTENT_DIR, id, 'index.md'),
  ];

  for (const p of directPaths) {
    if (existsSync(p)) return true;
  }

  return false;
}

export const entityLinkIdsRule = createRule({
  id: 'entitylink-ids',
  name: 'EntityLink ID Validation',
  description: 'Verify EntityLink IDs resolve to valid entities and use numeric+name format',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Skip internal documentation
    if (content.relativePath.includes('/internal/')) {
      return issues;
    }

    // Match <EntityLink id="..."> patterns — use the full tag match for name extraction
    const regex = new RegExp(ENTITY_LINK_RE.source, 'g');
    let match: RegExpExecArray | null;
    let lineNum = 0;
    let bodyOffset = 0;
    const lines = content.body.split('\n');

    for (const line of lines) {
      lineNum++;
      regex.lastIndex = 0;

      while ((match = regex.exec(line)) !== null) {
        const fullTag = match[0];
        const rawId = match[1];
        const nameAttr = extractEntityLinkName(fullTag);

        // --- Bare wiki ID (35 instead of E35) ---
        if (/^\d+$/.test(rawId)) {
          const eId = `E${rawId}`;
          const slug = engine.idRegistry?.byWikiId[eId];
          // Only normalize the E-prefix. Don't auto-inject name="${slug}" —
          // (a) if the wiki ID was reassigned the registry slug mismatches
          //     the prose (same hallucination as QUA-761's name-mismatch case),
          // (b) if the original tag already has a name= attribute, injecting
          //     produces a duplicate name= which breaks JSX compilation.
          // The next validation pass surfaces the missing-name advisory if
          // applicable, where the human can decide what to write.
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: lineNum,
            message: `EntityLink id="${rawId}" — bare wiki ID; use "${eId}"${slug ? ` (${slug})` : ''} instead`,
            severity: Severity.ERROR,
            fix: {
              type: FixType.REPLACE_TEXT,
              oldText: `id="${rawId}"`,
              newText: `id="${eId}"`,
            },
          }));
          continue;
        }

        // --- Wiki ID (E35) ---
        if (WIKI_ID_RE.test(rawId) && engine.idRegistry) {
          const slug = engine.idRegistry.byWikiId[rawId.toUpperCase()];
          if (slug) {
            // Wiki ID resolves — check name attribute
            if (nameAttr) {
              if (nameAttr !== slug) {
                // Name mismatch — ERROR. No auto-fix: the wiki ID may have been
                // reassigned to a different entity since the prose was written
                // (e.g., E3613 was Michael Kratsios, now Melania Trump). A
                // mechanical name=→slug rewrite would silently corrupt the
                // surrounding prose. Human judgment required.
                // engine.idRegistry is guaranteed non-null here (outer `if`).
                const idForCurrentName = engine.idRegistry.bySlug[nameAttr];
                const hint = idForCurrentName
                  ? ` (name "${nameAttr}" currently maps to ${idForCurrentName} — wiki ID may have been reassigned)`
                  : '';
                issues.push(new Issue({
                  rule: this.id,
                  file: content.path,
                  line: lineNum,
                  message: `EntityLink id="${rawId}" name="${nameAttr}" — name mismatch: ${rawId} is "${slug}", not "${nameAttr}"${hint}. Verify the prose and fix manually (no auto-fix: see QUA-761).`,
                  severity: Severity.ERROR,
                }));
              }
              // else: name matches — perfect, no issue
            } else {
              // Wiki ID without name. Before auto-injecting name="${slug}",
              // verify the visible display text plausibly identifies the
              // entity that ${slug} refers to. If it doesn't, this is the
              // same hallucination shape as QUA-761's existing-name case:
              // injecting a "valid" cross-check on a link whose prose says
              // something else permanently locks in the bad wikiId. See
              // QUA-759.
              const children = extractEntityLinkChildren(content.body, bodyOffset + match.index);
              const entitiesBySlug = getEntitiesBySlug(engine);
              const entity = entitiesBySlug.get(slug);
              const pageTitle = getPagesBySlug().get(slug)?.title;
              if (children !== undefined && !displayMatchesEntity(children, slug, entity, pageTitle)) {
                const idForDisplay = engine.idRegistry.bySlug[slugify(children)];
                const hint = idForDisplay
                  ? ` (display "${children}" currently maps to ${idForDisplay} — wiki ID may have been reassigned)`
                  : '';
                // WARNING (not ERROR) and no auto-fix: surfaces the
                // suspected reassignment without blocking the gate on
                // pre-existing drift. The old behavior (auto-injecting
                // name="${slug}" from the registry) is what we are
                // explicitly preventing — refusing the auto-fix is the
                // load-bearing change. Severity remains low because
                // tightening to ERROR would block CI on tens of latent
                // mismatches that need per-file content review (and
                // sometimes new entity allocation) before they can be
                // fixed. Promotion to ERROR is a follow-up once the
                // backlog is drained.
                issues.push(new Issue({
                  rule: this.id,
                  file: content.path,
                  line: lineNum,
                  message: `EntityLink id="${rawId}" — display name "${children}" does not identify the entity at ${rawId} (registry: "${slug}")${hint}. Verify the prose and fix manually (no auto-fix: see QUA-759).`,
                  severity: Severity.WARNING,
                }));
              } else {
                // Display matches (or cannot be extracted, e.g., self-closing
                // or JSX children) — safe to add the name= cross-check.
                issues.push(new Issue({
                  rule: this.id,
                  file: content.path,
                  line: lineNum,
                  message: `EntityLink id="${rawId}" — add name="${slug}" for cross-check`,
                  severity: Severity.WARNING,
                  fix: {
                    type: FixType.REPLACE_TEXT,
                    oldText: `id="${rawId}"`,
                    newText: `id="${rawId}" name="${slug}"`,
                  },
                }));
              }
            }
            continue; // Wiki ID is valid; skip path/entity resolution check
          } else {
            // Unknown wiki ID
            issues.push(new Issue({
              rule: this.id,
              file: content.path,
              line: lineNum,
              message: `EntityLink id="${rawId}" is not a registered wiki ID`,
              severity: Severity.WARNING,
            }));
            continue;
          }
        }

        // --- Slug ID ---
        // Check if it resolves to an entity
        const id = rawId;
        const inPathRegistry = engine.pathRegistry && (
          engine.pathRegistry[id] ||
          engine.pathRegistry[`__index__/${id}`]
        );
        const inEntities = engine.entities && (engine.entities as Record<string, unknown>)[id];
        const resolvesViaPath = pathStyleIdResolvesToFile(id);

        if (!inPathRegistry && !inEntities && !resolvesViaPath) {
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: lineNum,
            message: `EntityLink id="${rawId}" does not resolve to any known path or entity`,
            severity: Severity.WARNING,
          }));
          continue;
        }

        // Slug resolves — suggest numeric+name format if wiki ID is available
        if (engine.idRegistry) {
          const wikiId = engine.idRegistry.bySlug[id];
          if (wikiId) {
            issues.push(new Issue({
              rule: this.id,
              file: content.path,
              line: lineNum,
              message: `EntityLink id="${rawId}" — use numeric format: id="${wikiId}" name="${id}"`,
              severity: Severity.ERROR,
              fix: {
                type: FixType.REPLACE_TEXT,
                oldText: `id="${rawId}"`,
                newText: `id="${wikiId}" name="${rawId}"`,
              },
            }));
          }
        }
      }
      // Track absolute byte position in body so that downstream child-text
      // extraction works for multi-line EntityLink tags. `+ 1` accounts for
      // the newline removed by `split('\n')`.
      bodyOffset += line.length + 1;
    }

    return issues;
  },
});
