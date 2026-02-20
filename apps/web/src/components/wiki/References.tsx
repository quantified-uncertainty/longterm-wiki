import React from "react";
import { getResourceById, getResourcePublication } from "@data";

function formatCitation(id: string, index: number): React.ReactNode {
  const resource = getResourceById(id);

  if (!resource) {
    return (
      <li key={id} className="text-destructive italic text-sm">
        [{index}] Resource not found: {id}
      </li>
    );
  }

  const publication = getResourcePublication(resource);
  const year = resource.published_date ? resource.published_date.slice(0, 4) : null;
  const authors =
    resource.authors && resource.authors.length > 0
      ? resource.authors.slice(0, 3).join(", ") + (resource.authors.length > 3 ? " et al." : "")
      : null;

  return (
    <li key={id} id={`ref-${id}`} className="text-sm leading-relaxed py-0.5">
      <span className="text-muted-foreground mr-2 select-none">{index}.</span>
      {authors && <span className="text-muted-foreground">{authors}. </span>}
      <a
        href={resource.url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-accent-foreground hover:underline"
      >
        {resource.title}
      </a>
      {publication && (
        <span className="text-muted-foreground">
          {". "}
          <em>{publication.name}</em>
        </span>
      )}
      {year && <span className="text-muted-foreground">{". "}{year}</span>}
      {". "}
      <a
        href={resource.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-muted-foreground hover:underline break-all"
      >
        {resource.url}
      </a>
    </li>
  );
}

export function References({ ids }: { ids: string[] }) {
  if (!ids || ids.length === 0) return null;

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const uniqueIds = ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return (
    <section className="mt-8 pt-6 border-t border-border">
      <h2 className="text-lg font-semibold mb-3 text-foreground">References</h2>
      <ul className="list-none space-y-1 pl-0" role="list">
        {uniqueIds.map((id, i) => formatCitation(id, i + 1))}
      </ul>
    </section>
  );
}

export default References;
