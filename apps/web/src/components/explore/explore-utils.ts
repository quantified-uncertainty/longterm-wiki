import { getEntityTypeLabel, getEntityTypeBadgeColor } from "@/data/entity-ontology";

export function getTypeLabel(type: string): string {
  return getEntityTypeLabel(type);
}

export function getTypeColor(type: string): string {
  return getEntityTypeBadgeColor(type);
}

export function formatWordCount(count: number | null): string {
  if (count == null) return "";
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k words`;
  return `${count} words`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}
