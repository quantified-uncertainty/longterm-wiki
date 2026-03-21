import type { Metadata } from "next";
import {
  getAllKBRecords,
  getKBRecords,
} from "@/data/factbase";
import {
  parseDivision,
  resolveEntityLink,
  getDivisionHref,
  getDivisionAltKeys,
  DIVISION_TYPE_LABELS,
} from "./[slug]/division-data";
import { titleCase } from "@/components/wiki/factbase/format";
import { DivisionsTable, type DivisionRow, type TypeSummary } from "./divisions-table";

export const metadata: Metadata = {
  title: "Divisions",
  description:
    "Directory of organizational divisions, teams, departments, and program areas tracked in the knowledge base.",
};

/**
 * Check whether a division has meaningful data beyond just its name/type/org.
 * A division "has data" if it has personnel, grants, funding programs,
 * a lead, a website, or notes.
 */
function divisionHasData(record: import("@/data/factbase").KBRecordEntry): boolean {
  const division = parseDivision(record);

  // Check basic fields
  if (division.lead) return true;
  if (division.website) return true;
  if (division.notes) return true;

  // Check personnel (via all alternate keys for merged divisions)
  const allDivKeys = getDivisionAltKeys(record);
  for (const key of allDivKeys) {
    const personnel = getKBRecords(`__division__${key}`, "division-personnel");
    if (personnel.length > 0) return true;
  }

  // Check funding programs linked to this division
  const allPrograms = getAllKBRecords("funding-programs");
  for (const p of allPrograms) {
    const divId = p.fields.divisionId;
    if (typeof divId === "string" && allDivKeys.has(divId)) return true;
  }

  // Check grants (via parent org)
  const parentGrants = getKBRecords(division.ownerEntityId, "grants");
  const allDivKeysLower = new Set([...allDivKeys].map((k) => k.toLowerCase()));
  const divisionNameLower = division.name.toLowerCase();
  for (const g of parentGrants) {
    const programId = g.fields.programId as string | undefined;
    if (programId && allDivKeys.has(programId)) return true;
    const gDiv = g.fields.divisionName as string | undefined;
    const gProgram = g.fields.program as string | undefined;
    if (gDiv && (gDiv.toLowerCase() === divisionNameLower || allDivKeysLower.has(gDiv.toLowerCase()))) return true;
    if (gProgram && allDivKeysLower.has(gProgram.toLowerCase())) return true;
  }

  return false;
}

export default function DivisionsPage() {
  const allRecords = getAllKBRecords("divisions");

  // Deduplicate by owner+name (same logic as division-data.ts)
  const seen = new Map<string, { row: DivisionRow; record: import("@/data/factbase").KBRecordEntry }>();
  for (const record of allRecords) {
    const division = parseDivision(record);
    const mapKey = `${division.ownerEntityId}::${division.name}`;
    if (seen.has(mapKey)) continue;

    const parent = resolveEntityLink(division.ownerEntityId);
    const href = getDivisionHref(division);

    seen.set(mapKey, {
      row: {
        key: division.key,
        name: division.name,
        parentName: parent.name,
        parentHref: parent.href,
        divisionType: division.divisionType,
        status: division.status,
        href,
        hasData: false, // computed below
      },
      record,
    });
  }

  // Compute hasData for each division
  const rows: DivisionRow[] = [];
  for (const { row, record } of seen.values()) {
    row.hasData = divisionHasData(record);
    rows.push(row);
  }

  rows.sort(
    (a, b) =>
      a.parentName.localeCompare(b.parentName) ||
      a.name.localeCompare(b.name),
  );

  // Summary stats
  const totalDivisions = rows.length;
  const uniqueOrgs = new Set(rows.map((r) => r.parentName)).size;
  const activeCount = rows.filter((r) => r.status === "active").length;
  const divisionsWithData = rows.filter((r) => r.hasData).length;

  // Type breakdown (across all divisions)
  const typeCounts = new Map<string, number>();
  for (const r of rows) {
    typeCounts.set(r.divisionType, (typeCounts.get(r.divisionType) ?? 0) + 1);
  }
  const typeSummary: TypeSummary[] = [...typeCounts.entries()]
    .map(([type, count]) => ({
      type,
      label: DIVISION_TYPE_LABELS[type] ?? titleCase(type),
      count,
    }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Divisions
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of organizational divisions, teams, departments, and program
          areas tracked in the knowledge base.
        </p>
      </div>

      <DivisionsTable
        rows={rows}
        typeSummary={typeSummary}
        totalDivisions={totalDivisions}
        uniqueOrgs={uniqueOrgs}
        activeCount={activeCount}
        divisionsWithData={divisionsWithData}
      />
    </div>
  );
}
