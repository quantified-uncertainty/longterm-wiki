import type { KBRecordEntry } from "@/data/factbase";
import { resolveEntityName } from "@/lib/resolve-entity-name";
import { parseNumericOrRange, type NumericOrRange } from "./common";

export type ParsedGrantRecord = {
  key: string;
  name: string;
  recipient: string | null;
  recipientName: string;
  recipientHref: string | null;
  amount: NumericOrRange | null;
  date: string | null;
  status: string | null;
  source: string | null;
  programName: string | null;
  divisionName: string | null;
  notes: string | null;
};

export type ReceivedGrant = ParsedGrantRecord & {
  funderName: string;
  funderHref: string | null;
  funderSlug: string | null;
};

export function parseGrantRecord(record: KBRecordEntry): ParsedGrantRecord {
  const f = record.fields;
  const recipientId = (f.recipient as string) ?? null;
  const resolved = recipientId ? resolveEntityName(recipientId, record.displayName) : { name: "", href: null };
  return {
    key: record.key,
    name: (f.name as string) ?? record.key,
    recipient: recipientId,
    recipientName: resolved.name,
    recipientHref: resolved.href,
    amount: parseNumericOrRange(f.amount),
    date: (f.date as string) ?? (f.period as string) ?? null,
    status: (f.status as string) ?? null,
    source: (f.source as string) ?? null,
    programName: (f.programName as string) ?? null,
    divisionName: (f.divisionName as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}
