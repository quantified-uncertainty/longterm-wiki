import { getPageChangeSessions } from "@/data";
import { PageChangesSessions } from "./page-changes-sessions";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Page Changes | Longterm Wiki Internal",
  description:
    "Timeline of wiki page edits from Claude Code sessions, grouped by session.",
};

export default function PageChangesPage() {
  const sessions = getPageChangeSessions();

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
