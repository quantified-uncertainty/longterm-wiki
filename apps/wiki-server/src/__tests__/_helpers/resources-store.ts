/**
 * Shared in-memory store for `resources` + `resource_citations` test mocks.
 *
 * Prod invariants this mirrors (QUA-566 Phase B.3):
 *   - Every row in `resources` has a `stable_id` (sid_) — NOT NULL since migration 0184.
 *   - `resource_citations.resource_id` FKs to `resources.stable_id` (not `resources.id`).
 *
 * Tests that need to seed a resource without caring about stable_id get one auto-derived
 * (`sid_${id}`). Tests that need a specific stable_id pass it explicitly.
 *
 * See QUA-604 for why this exists — prior to consolidation, resources.test.ts kept a raw
 * `Map<string, Row>` keyed on hex16 `id` plus a separate `Citation[]` array, and each
 * Phase B PR that touched the mocks had to patch 2-5 dispatcher branches by hand,
 * repeatedly missing spots.
 */

export interface ResourceRow {
  id: string;
  stable_id: string;
  url: string;
  title?: string | null;
  type?: string | null;
  summary?: string | null;
  review?: string | null;
  abstract?: string | null;
  key_points?: unknown;
  publication_id?: string | null;
  authors?: unknown;
  published_date?: string | null;
  tags?: unknown;
  local_filename?: string | null;
  credibility_override?: number | null;
  fetched_at?: Date | null;
  content_hash?: string | null;
  enrichment_status?: string | null;
  has_content?: boolean;
  created_at?: Date;
  updated_at?: Date;
  [key: string]: unknown;
}

export interface Citation {
  resource_id: string;
  page_slug: string;
  page_id: number;
  created_at: Date;
}

export type ResourceSeed = Partial<ResourceRow> & { id: string; url: string };

export class ResourcesStore {
  private byId = new Map<string, ResourceRow>();
  private byStableId = new Map<string, ResourceRow>();
  private citations: Citation[] = [];
  private slugToIntId = new Map<string, number>();
  private nextIntId = 1000;

  reset(): void {
    this.byId.clear();
    this.byStableId.clear();
    this.citations = [];
    this.slugToIntId.clear();
    this.nextIntId = 1000;
  }

  /**
   * Seed a resource from a test. `stable_id` auto-derived as `sid_${id}` if omitted —
   * sufficient for tests that don't exercise citation joins. Tests that DO care about
   * a specific stable_id should pass it explicitly.
   */
  seedResource(seed: ResourceSeed): ResourceRow {
    const stable_id = seed.stable_id ?? `sid_${seed.id}`;
    const now = new Date();
    const row: ResourceRow = {
      ...seed,
      id: seed.id,
      stable_id,
      url: seed.url,
      title: seed.title ?? null,
      fetched_at: seed.fetched_at ?? null,
      has_content: seed.has_content ?? false,
      created_at: seed.created_at ?? now,
      updated_at: seed.updated_at ?? now,
    };
    this.setResource(row);
    return row;
  }

  /** Low-level set — used by INSERT dispatch. Maintains both id and stable_id indices. */
  setResource(row: ResourceRow): void {
    const existing = this.byId.get(row.id);
    if (existing && existing.stable_id !== row.stable_id) {
      this.byStableId.delete(existing.stable_id);
    }
    this.byId.set(row.id, row);
    this.byStableId.set(row.stable_id, row);
  }

  getById(id: string): ResourceRow | undefined {
    return this.byId.get(id);
  }

  getByStableId(stableId: string): ResourceRow | undefined {
    return this.byStableId.get(stableId);
  }

  /** Resolve identifier that may be either hex16 id or sid_. */
  resolveResource(identifier: string): ResourceRow | undefined {
    return this.byId.get(identifier) ?? this.byStableId.get(identifier);
  }

  getByUrl(url: string): ResourceRow | undefined {
    for (const r of this.byId.values()) {
      if (r.url === url) return r;
    }
    return undefined;
  }

  allResources(): ResourceRow[] {
    return Array.from(this.byId.values());
  }

  resourceCount(): number {
    return this.byId.size;
  }

  countByType(type: string): number {
    let n = 0;
    for (const r of this.byId.values()) if (r.type === type) n++;
    return n;
  }

  groupByType(): Array<{ type: string; count: number }> {
    const counts: Record<string, number> = {};
    for (const r of this.byId.values()) {
      const t = (r.type as string) ?? "unknown";
      counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }

  clearResources(): void {
    this.byId.clear();
    this.byStableId.clear();
  }

  // ---- citations ----

  /**
   * Seed a citation from a test. The `resourceIdentifier` may be either hex16 id or sid_ —
   * the store resolves to the canonical `stable_id` internally. Throws if the referenced
   * resource hasn't been seeded (mirrors the FK constraint in prod).
   */
  seedCitation(input: { resourceIdentifier: string; pageSlug: string }): Citation {
    const resource = this.resolveResource(input.resourceIdentifier);
    if (!resource) {
      throw new Error(
        `seedCitation: no resource with id/stable_id "${input.resourceIdentifier}". ` +
          `Call seedResource first.`,
      );
    }
    return this.insertCitation(resource.stable_id, input.pageSlug);
  }

  /** Low-level citation insert used by INSERT dispatch. Expects a resolved stable_id. */
  insertCitation(stableId: string, pageSlug: string): Citation {
    const page_id = this.getOrAllocatePageId(pageSlug);
    const existing = this.citations.find(
      (c) => c.resource_id === stableId && c.page_id === page_id,
    );
    if (existing) return existing;
    const citation: Citation = {
      resource_id: stableId,
      page_slug: pageSlug,
      page_id,
      created_at: new Date(),
    };
    this.citations.push(citation);
    return citation;
  }

  /** Low-level citation insert by page_id (for dispatch paths that already have the int id). */
  insertCitationByPageId(stableId: string, pageId: number): Citation {
    const slug = this.slugFromPageId(pageId) ?? `page-${pageId}`;
    const existing = this.citations.find(
      (c) => c.resource_id === stableId && c.page_id === pageId,
    );
    if (existing) return existing;
    const citation: Citation = {
      resource_id: stableId,
      page_slug: slug,
      page_id: pageId,
      created_at: new Date(),
    };
    this.citations.push(citation);
    return citation;
  }

  deleteCitationsForResource(stableId: string): void {
    this.citations = this.citations.filter((c) => c.resource_id !== stableId);
  }

  getCitationsForResource(stableId: string): Citation[] {
    return this.citations.filter((c) => c.resource_id === stableId);
  }

  allCitations(): readonly Citation[] {
    return this.citations;
  }

  citationCount(): number {
    return this.citations.length;
  }

  uniquePageCount(): number {
    return new Set(this.citations.map((c) => c.page_id)).size;
  }

  clearCitations(): void {
    this.citations = [];
  }

  /** INNER JOIN resource_citations × resources on stable_id, filtered by page_id. */
  joinCitationsByPage(pageId: number): ResourceRow[] {
    const rows: ResourceRow[] = [];
    for (const c of this.citations) {
      if (c.page_id === pageId) {
        const r = this.byStableId.get(c.resource_id);
        if (r) rows.push(r);
      }
    }
    return rows;
  }

  /**
   * For a set of hex16 ids, return citation counts keyed on the input hex16 id
   * (prod surfaces `r.id` from the JOIN so downstream map-by-hex16 lookups work).
   */
  citationCountsByHexIds(hexIds: string[]): Array<{ resource_id: string; cnt: string }> {
    const counts: Record<string, number> = {};
    for (const hexId of hexIds) {
      const r = this.byId.get(hexId);
      if (!r?.stable_id) continue;
      const n = this.citations.filter((c) => c.resource_id === r.stable_id).length;
      if (n > 0) counts[hexId] = n;
    }
    return Object.entries(counts).map(([resource_id, cnt]) => ({
      resource_id,
      cnt: String(cnt),
    }));
  }

  // ---- page slug <-> int id ----

  /** Allocating lookup — mirrors prod where every page slug has a `wiki_pages` row. */
  getOrAllocatePageId(slug: string): number {
    let id = this.slugToIntId.get(slug);
    if (id === undefined) {
      id = this.nextIntId++;
      this.slugToIntId.set(slug, id);
    }
    return id;
  }

  slugFromPageId(pageId: number | null): string | null {
    if (pageId === null) return null;
    for (const [slug, id] of this.slugToIntId.entries()) {
      if (id === pageId) return slug;
    }
    return null;
  }
}

/** Factory — tests call this in beforeEach or once at module scope and call reset() in beforeEach. */
export function makeResourcesStore(): ResourcesStore {
  return new ResourcesStore();
}
