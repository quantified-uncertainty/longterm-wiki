import React from "react";
import { ExternalLinks } from "./ExternalLinks";
import { getExternalLinks, type ExternalLinksData } from "@data";

export function DataExternalLinks({
  pageId,
  links: manualLinks,
}: {
  pageId: string;
  links?: ExternalLinksData;
}) {
  const links = manualLinks ?? getExternalLinks(pageId);
  if (!links) return null;
  return <ExternalLinks pageId={pageId} links={links} />;
}

export default DataExternalLinks;
