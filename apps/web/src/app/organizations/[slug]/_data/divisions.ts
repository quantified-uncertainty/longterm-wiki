import type { KBRecordEntry } from "@/data/factbase";

export function parseDivisionRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    ownerEntityId: record.ownerEntityId,
    slug: (f.slug as string) ?? null,
    name: (f.name as string) ?? record.key,
    divisionType: (f.divisionType as string) ?? "team",
    lead: (f.lead as string) ?? null,
    status: (f.status as string) ?? null,
    startDate: (f.startDate as string) ?? null,
    endDate: (f.endDate as string) ?? null,
    website: (f.website as string) ?? null,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
    description: (f.description as string) ?? null,
  };
}

export type ParsedDivisionRecord = ReturnType<typeof parseDivisionRecord>;
