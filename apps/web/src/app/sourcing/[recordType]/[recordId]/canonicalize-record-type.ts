const PLURAL_TO_SINGULAR: Record<string, string> = {
  grants: "grant",
  publications: "publication",
  divisions: "division",
  investments: "investment",
  personnels: "personnel",
  "board-seats": "board-seat",
  "funding-programs": "funding-program",
  "funding-rounds": "funding-round",
  "policy-stakeholders": "policy-stakeholder",
  citations: "citation",
  "wiki-pages": "wiki-page",
};

export function canonicalizeSourcingRecordType(recordType: string): string | null {
  return PLURAL_TO_SINGULAR[recordType] ?? null;
}
