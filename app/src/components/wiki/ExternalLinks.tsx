import React from "react";
import { ExternalLink, BookOpen, MessageSquare, GraduationCap, Briefcase, Bot } from "lucide-react";

// Re-use the canonical type from the data layer
import type { ExternalLinksData } from "@/data";

const platformConfig = {
  wikipedia: { name: "Wikipedia", icon: BookOpen },
  wikidata: { name: "Wikidata", icon: BookOpen },
  lesswrong: { name: "LessWrong", icon: GraduationCap },
  alignmentForum: { name: "Alignment Forum", icon: GraduationCap },
  eaForum: { name: "EA Forum", icon: MessageSquare },
  stampy: { name: "AI Safety Info", icon: MessageSquare },
  arbital: { name: "Arbital", icon: BookOpen },
  eightyK: { name: "80,000 Hours", icon: Briefcase },
  grokipedia: { name: "Grokipedia", icon: Bot },
};

type PlatformKey = keyof typeof platformConfig;

// External links are now shown in the InfoBox sidebar, so this inline component is a no-op.
export function ExternalLinks({ pageId, links }: { pageId: string; links?: ExternalLinksData }) {
  return null;
}

export default ExternalLinks;
