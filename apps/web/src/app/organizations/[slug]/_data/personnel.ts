import type { KBRecordEntry } from "@/data/factbase";

export interface BoardMember {
  key: string;
  personId: string | null;
  personName: string;
  personHref: string | null;
  role: string | null;
  appointed: string | null;
  departed: string | null;
  appointedBy: string | null;
  source: string | null;
}

export function parsePersonnelRecord(record: KBRecordEntry) {
  const f = record.fields;
  const schema = record.schema;

  // Extract person ID — key-person and board use different field names
  const personId =
    (f.person as string) ?? (f.member as string) ?? null;

  // Extract role/title
  const role = (f.title as string) ?? (f.role as string) ?? null;

  // Extract dates — key-person uses start/end, board uses appointed/departed
  const startDate =
    (f.start as string) ?? (f.appointed as string) ?? null;
  const endDate =
    (f.end as string) ?? (f.departed as string) ?? null;

  const isFounder = (f.is_founder as boolean) ?? false;

  // Determine display role type from schema
  const roleType =
    schema === "key-person"
      ? "key-person"
      : schema === "board-seat"
        ? "board"
        : "career";

  return {
    key: record.key,
    personId,
    role,
    roleType,
    startDate,
    endDate,
    isFounder,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

export type ParsedPersonnelRecord = ReturnType<typeof parsePersonnelRecord> & {
  personName: string;
  personHref: string | null;
};

export function parseBoardSeatRecord(record: KBRecordEntry): Omit<BoardMember, "personName" | "personHref"> {
  const f = record.fields;
  return {
    key: record.key,
    personId: (f.member as string) ?? null,
    role: (f.role as string) ?? null,
    appointed: (f.appointed as string) ?? null,
    departed: (f.departed as string) ?? null,
    appointedBy: (f.appointed_by as string) ?? null,
    source: (f.source as string) ?? null,
  };
}
