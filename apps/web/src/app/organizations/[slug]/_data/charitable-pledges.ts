import type { KBRecordEntry } from "@/data/factbase";
import { parseNumericOrRange } from "./common";

export function parseCharitablePledgeRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    pledgerId: (f.pledger as string) ?? null,
    pledge: parseNumericOrRange(f.pledge),
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

export type ParsedCharitablePledgeRecord = ReturnType<typeof parseCharitablePledgeRecord>;
