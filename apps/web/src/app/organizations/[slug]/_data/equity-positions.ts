import type { KBRecordEntry } from "@/data/factbase";
import { parseNumericOrRange } from "./common";

export function parseEquityPositionRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    holderId: (f.holder as string) ?? null,
    stake: parseNumericOrRange(f.stake),
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
    asOf: "asOf" in record ? (record as { asOf?: string }).asOf : undefined,
  };
}

export type ParsedEquityPositionRecord = ReturnType<typeof parseEquityPositionRecord> & {
  holderName: string;
  holderHref: string | null;
};
