import { getPageChanges } from "@/data";
import { PageChangesTable } from "./page-changes-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Page Changes | Longterm Wiki Internal",
  description:
    "Timeline of page edits from Claude Code sessions, grouped by session.",
};

export default function PageChangesPage() {
  const items = getPageChanges();

  // Group by session (branch + date) for summary stats
  const sessions = new Map<string, Set<string>>();
  for (const item of items) {
    const key = `${item.date}|${item.branch}`;
    if (!sessions.has(key)) sessions.set(key, new Set());
    sessions.get(key)!.add(item.pageId);
  }

  const uniquePages = new Set(items.map((i) => i.pageId));

  return (
    <article className="prose max-w-none">
      <h1>Page Changes</h1>
      <p className="text-muted-foreground">
        Timeline of wiki page edits from Claude Code sessions.{" "}
        <span className="font-medium text-foreground">{items.length}</span>{" "}
        changes across{" "}
        <span className="font-medium text-foreground">{uniquePages.size}</span>{" "}
        pages from{" "}
        <span className="font-medium text-foreground">{sessions.size}</span>{" "}
        sessions.
      </p>
      {items.length === 0 ? (
        <p className="text-muted-foreground italic">
          No page changes recorded yet. Session log entries with a{" "}
          <code>Pages:</code> field will appear here.
        </p>
      ) : (
        <PageChangesTable data={items} />
      )}
    </article>
  );
}
