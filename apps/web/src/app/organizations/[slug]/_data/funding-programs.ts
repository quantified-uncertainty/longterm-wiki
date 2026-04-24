import type { KBRecordEntry } from "@/data/factbase";

export function parseFundingProgramRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    name: (f.name as string) ?? record.key,
    programType: (f.programType as string) ?? "grant-round",
    description: (f.description as string) ?? null,
    totalBudget: typeof f.totalBudget === "number" ? f.totalBudget : null,
    currency: (f.currency as string) ?? "USD",
    applicationUrl: (f.applicationUrl as string) ?? null,
    openDate: (f.openDate as string) ?? null,
    deadline: (f.deadline as string) ?? null,
    status: (f.status as string) ?? null,
    source: (f.source as string) ?? null,
  };
}

export type ParsedFundingProgramRecord = ReturnType<typeof parseFundingProgramRecord>;
