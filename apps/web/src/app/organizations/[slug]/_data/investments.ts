import type { KBRecordEntry } from "@/data/factbase";
import { parseNumericOrRange } from "./common";

export function parseInvestmentRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    investorId: (f.investor as string) ?? null,
    roundName: (f.round_name as string) ?? null,
    date: (f.date as string) ?? null,
    amount: parseNumericOrRange(f.amount),
    stakeAcquired: parseNumericOrRange(f.stake_acquired),
    instrument: (f.instrument as string) ?? null,
    role: (f.role as string) ?? null,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

export type ParsedInvestmentRecord = ReturnType<typeof parseInvestmentRecord> & {
  investorName: string;
  investorHref: string | null;
};
