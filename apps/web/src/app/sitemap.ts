import type { MetadataRoute } from "next";
import { getAllPages, getEntityHref } from "@/data";
import { SITE_URL } from "@/lib/site-config";

export default function sitemap(): MetadataRoute.Sitemap {
  // Exclude internal pages — they are not public content
  const pages = getAllPages().filter((p) => p.category !== "internal");

  const pageEntries: MetadataRoute.Sitemap = pages.map((page) => ({
    url: `${SITE_URL}${getEntityHref(page.id)}`,
    lastModified: page.lastUpdated ?? undefined,
    changeFrequency: deriveChangeFrequency(page.updateFrequency ?? null),
    priority: derivePriority(page.readerImportance),
  }));

  const staticEntries: MetadataRoute.Sitemap = [
    { url: SITE_URL, changeFrequency: "weekly", priority: 1.0 },
    { url: `${SITE_URL}/wiki`, changeFrequency: "weekly", priority: 0.9 },
  ];

  return [...staticEntries, ...pageEntries];
}

/** Map importance (0-100) to sitemap priority (0.0-1.0). */
function derivePriority(importance: number | null): number {
  if (importance == null) return 0.3;
  return Math.round(Math.max(0.1, importance / 100) * 10) / 10;
}

/** Map updateFrequency (days) to sitemap changeFrequency. */
function deriveChangeFrequency(
  updateFrequencyDays: number | null,
): "daily" | "weekly" | "monthly" | "yearly" {
  if (updateFrequencyDays == null) return "monthly";
  if (updateFrequencyDays <= 7) return "daily";
  if (updateFrequencyDays <= 30) return "weekly";
  if (updateFrequencyDays <= 180) return "monthly";
  return "yearly";
}
