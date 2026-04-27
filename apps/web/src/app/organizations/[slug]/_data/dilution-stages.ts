import type { KBRecordEntry } from "@/data/factbase";

export function parseDilutionStageRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    round: (f.round as string) ?? record.key,
    date: (f.date as string) ?? null,
    foundersPercent: typeof f.foundersPercent === "number" ? f.foundersPercent : 0,
    employeesPercent: typeof f.employeesPercent === "number" ? f.employeesPercent : 0,
    investorsPercent: typeof f.investorsPercent === "number" ? f.investorsPercent : 0,
    valuation: typeof f.valuation === "number" ? f.valuation : undefined,
    notes: (f.notes as string) ?? null,
  };
}

export type ParsedDilutionStageRecord = ReturnType<typeof parseDilutionStageRecord>;
