import React from "react";
import Link from "next/link";
import { getBacklinksFor } from "@data";
import { Link2, ArrowLeft } from "lucide-react";

export function Backlinks({
  entityId,
  title = "What links here",
  showEmpty = false,
  maxItems,
  compact = false,
}: {
  entityId: string;
  title?: string;
  showEmpty?: boolean;
  maxItems?: number;
  compact?: boolean;
}) {
  const links = getBacklinksFor(entityId);

  if (links.length === 0 && !showEmpty) return null;

  const displayLinks = maxItems ? links.slice(0, maxItems) : links;
  const hasMore = maxItems && links.length > maxItems;

  if (compact) {
    return (
      <div className="backlinks backlinks--compact">
        <span className="backlinks__label">
          <Link2 className="backlinks__icon" size={14} />
          {links.length} {links.length === 1 ? "page links" : "pages link"} here
        </span>
        {links.length > 0 && (
          <span className="backlinks__list-inline">
            {displayLinks.map((link, i) => (
              <span key={link.id}>
                <Link href={link.href} className="backlinks__link">{link.title}</Link>
                {i < displayLinks.length - 1 && ", "}
              </span>
            ))}
            {hasMore && <span className="backlinks__more">+{links.length - maxItems!} more</span>}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="backlinks">
      <h3 className="backlinks__title">
        <ArrowLeft className="backlinks__icon" size={16} />
        {title}
      </h3>
      {links.length === 0 ? (
        <p className="backlinks__empty">No pages link to this article yet.</p>
      ) : (
        <>
          <ul className="backlinks__list">
            {displayLinks.map((link) => (
              <li key={link.id} className="backlinks__item">
                <Link href={link.href} className="backlinks__link">{link.title}</Link>
                <span className="backlinks__type">{link.type}</span>
                {link.relationship && link.relationship !== "related" && (
                  <span className="backlinks__relationship">{link.relationship}</span>
                )}
              </li>
            ))}
          </ul>
          {hasMore && <p className="backlinks__more-link">And {links.length - maxItems!} more...</p>}
        </>
      )}
    </div>
  );
}

export default Backlinks;
