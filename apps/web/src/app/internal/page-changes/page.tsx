import {
  getPageChangeSessions,
  getAllPages,
  getIdRegistry,
  type PageChangesSession,
} from "@/data";
import { PageChangesSessions } from "./page-changes-sessions";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Page Changes | Longterm Wiki Internal",
  description:
    "Timeline of wiki page edits from Claude Code sessions, grouped by session.",
};

// ── API types ────────────────────────────────────────────────────────────────

interface ApiSession {
  id: number;
  date: string;
  branch: string | null;
  title: string;
  summary: string | null;
  model: string | null;
  duration: string | null;
  cost: string | null;
  prUrl: string | null;
  pages: string[];
}

// ── Data loading ─────────────────────────────────────────────────────────────

/** Extract PR number from a GitHub PR URL like "https://github.com/.../pull/123" */
function extractPrNumber(prUrl: string | null): number | undefined {
  if (!prUrl) return undefined;
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Load page-changes data from the wiki-server API.
 * Returns null if the server is unavailable.
 */
async function loadSessionsFromApi(): Promise<PageChangesSession[] | null> {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) return null;

  try {
    const headers: Record<string, string> = {};
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${serverUrl}/api/sessions/page-changes`, {
      headers,
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { sessions: ApiSession[] };

    // Build a page metadata lookup from local database.json
    const pages = getAllPages();
    const idRegistry = getIdRegistry();
    const pageMap = new Map(
      pages.map((p) => [
        p.id,
        {
          title: p.title,
          path: p.path,
          category: p.category,
          numericId: idRegistry?.bySlug[p.id] || p.id,
        },
      ])
    );

    return data.sessions
      .filter((s) => s.pages.length > 0)
      .map((s) => {
        const pr = extractPrNumber(s.prUrl);
        return {
          sessionKey: `${s.date}|${s.branch || "unknown"}`,
          date: s.date,
          branch: s.branch || "unknown",
          sessionTitle: s.title,
          summary: s.summary || "",
          ...(pr !== undefined && { pr }),
          ...(s.model && { model: s.model }),
          ...(s.duration && { duration: s.duration }),
          ...(s.cost && { cost: s.cost }),
          pages: s.pages.map((pageId) => {
            const meta = pageMap.get(pageId);
            return {
              pageId,
              pageTitle: meta?.title || pageId,
              pagePath: meta?.path || `/wiki/${pageId}`,
              numericId: meta?.numericId || pageId,
              category: meta?.category || "unknown",
            };
          }),
        };
      });
  } catch {
    return null;
  }
}

export default async function PageChangesPage() {
  // Try wiki-server API first, fall back to database.json
  const apiSessions = await loadSessionsFromApi();
  const sessions = apiSessions ?? getPageChangeSessions();
  const dataSource = apiSessions ? "wiki-server" : "local fallback";

  const totalPageEdits = sessions.reduce((n, s) => n + s.pages.length, 0);
  const uniquePages = new Set(
    sessions.flatMap((s) => s.pages.map((p) => p.pageId))
  );

  return (
    <article className="prose max-w-none">
      <h1>Page Changes</h1>
      <p className="text-muted-foreground">
        Timeline of wiki page edits from Claude Code sessions.{" "}
        <span className="font-medium text-foreground">{sessions.length}</span>{" "}
        sessions,{" "}
        <span className="font-medium text-foreground">{totalPageEdits}</span>{" "}
        page edits across{" "}
        <span className="font-medium text-foreground">{uniquePages.size}</span>{" "}
        unique pages.
      </p>
      <p className="text-xs text-muted-foreground">
        Data source: {dataSource}.
      </p>
      {sessions.length === 0 ? (
        <p className="text-muted-foreground italic">
          No page changes recorded yet. Session log entries with a{" "}
          <code>pages</code> field will appear here.
        </p>
      ) : (
        <PageChangesSessions sessions={sessions} />
      )}
    </article>
  );
}
