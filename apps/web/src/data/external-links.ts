/**
 * External links data (loaded from YAML via fs).
 */

import fs from "fs";
import path from "path";
import { DATA_DIR, loadYaml, resolveId } from "./database";

export interface ExternalLinksData {
  wikipedia?: string;
  wikidata?: string;
  lesswrong?: string;
  alignmentForum?: string;
  eaForum?: string;
  stampy?: string;
  arbital?: string;
  eightyK?: string;
  grokipedia?: string;
}

let _externalLinksMap: Map<string, ExternalLinksData> | null = null;

function loadExternalLinksMap(): Map<string, ExternalLinksData> {
  if (_externalLinksMap) return _externalLinksMap;

  try {
    const yamlPath = path.join(DATA_DIR, "external-links.yaml");
    const raw = fs.readFileSync(yamlPath, "utf-8");
    const entries = loadYaml<Array<{
      pageId: string;
      links: ExternalLinksData;
    }>>(raw);
    _externalLinksMap = new Map();
    for (const entry of entries) {
      if (entry.pageId && entry.links) {
        _externalLinksMap.set(entry.pageId, entry.links);
      }
    }
    return _externalLinksMap;
  } catch {
    return new Map();
  }
}

export function getExternalLinks(
  pageId: string
): ExternalLinksData | undefined {
  return loadExternalLinksMap().get(resolveId(pageId));
}
