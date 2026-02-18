import React from "react";
import type { ExternalLinksData } from "@/data";

// External links are now shown in the InfoBox sidebar, so this inline component is a no-op.
// Platform display config lives in InfoBox.tsx (externalLinkPlatforms).
export function ExternalLinks({ pageId, links }: { pageId: string; links?: ExternalLinksData }) {
  return null;
}

export default ExternalLinks;
