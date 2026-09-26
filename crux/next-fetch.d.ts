// apps/web modules reached through crux's `@/` path aliases (e.g.
// apps/web/src/lib/wiki-server.ts) pass Next.js's `next` extension to fetch().
// crux does not load Next's global types, so declare just that field here.
interface RequestInit {
  next?: { revalidate?: number | false; tags?: string[] };
}
