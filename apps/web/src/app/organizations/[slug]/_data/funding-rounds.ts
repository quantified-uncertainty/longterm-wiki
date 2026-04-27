import type { KBRecordEntry } from "@/data/factbase";

export function parseFundingRoundRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    name: (f.name as string) ?? record.key,
    date: (f.date as string) ?? null,
    raised: typeof f.raised === "number" ? f.raised : null,
    valuation: typeof f.valuation === "number" ? f.valuation : null,
    instrument: (f.instrument as string) ?? null,
    leadInvestor: (f.lead_investor as string) ?? null,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

export type ParsedFundingRoundRecord = ReturnType<typeof parseFundingRoundRecord> & {
  leadInvestorName: string;
  leadInvestorHref: string | null;
};
