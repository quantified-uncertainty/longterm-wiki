import type { PersonEntity } from "@/data/entity-schemas";

/**
 * Infer political metadata from a person entity's description and customFields.
 * Mirrors the inference logic in /politicians/page.tsx.
 */

function inferParty(entity: PersonEntity): string | null {
  const textsToSearch: string[] = [(entity.description ?? "").toLowerCase()];
  if (entity.customFields) {
    for (const field of entity.customFields) {
      textsToSearch.push(field.value.toLowerCase());
    }
  }
  for (const text of textsToSearch) {
    if (text.includes("(d)") || text.includes("(d-") || text.includes("democrat")) return "Democratic";
    if (text.includes("(r)") || text.includes("(r-") || text.includes("republican")) return "Republican";
  }
  return null;
}

function inferOffice(entity: PersonEntity): string | null {
  const desc = entity.description ?? "";
  if (/U\.S\. Senator/i.test(desc)) return "U.S. Senator";
  if (/U\.S\. Representative/i.test(desc)) return "U.S. Representative";
  if (/State Senator/i.test(desc)) return "State Senator";
  if (/State Assembl/i.test(desc)) return "State Assemblymember";
  if (/Governor/i.test(desc)) return "Governor";
  if (/Attorney General/i.test(desc)) return "Attorney General";
  if (/candidate/i.test(desc)) return "Candidate";
  return null;
}

function inferJurisdiction(entity: PersonEntity): string | null {
  const desc = entity.description ?? "";
  const districtMatch = desc.match(/\b([A-Z]{2})-(\d+)\b/);
  if (districtMatch) return districtMatch[0];
  const statePatterns = [
    /Nebraska/i, /Tennessee/i, /Maine/i, /Texas/i, /Georgia/i,
    /Florida/i, /Michigan/i, /North Carolina/i, /New York/i,
    /New Jersey/i, /Illinois/i, /California/i, /Oregon/i,
    /Durham/i,
  ];
  for (const pattern of statePatterns) {
    const m = desc.match(pattern);
    if (m) return m[0];
  }
  return null;
}

function inferStatus(entity: PersonEntity): string | null {
  const desc = (entity.description ?? "").toLowerCase();
  if (desc.includes("former") || desc.includes("lost")) return "Former";
  if (desc.includes("incumbent")) return "Incumbent";
  const incumbentTitles = [
    "u.s. senator", "u.s. representative",
    "state senator", "state representative", "assemblymember",
    "governor", "attorney general", "secretary of state",
    "mayor", "commissioner", "comptroller", "treasurer",
  ];
  if (incumbentTitles.some((t) => desc.includes(t))) return "Incumbent";
  if (desc.includes("candidate") || desc.includes("running") || desc.includes("nominee") || desc.includes("runoff")) return "Candidate";
  return "Candidate";
}

const PARTY_BADGE: Record<string, string> = {
  Democratic: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  Republican: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

const STATUS_BADGE: Record<string, string> = {
  Incumbent: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  Candidate: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  Former: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

interface PoliticalInfoProps {
  entity: PersonEntity;
}

/**
 * Renders a compact "Political Info" card for politician entities.
 * Only renders when the entity has the "politics" tag.
 */
export function PoliticalInfo({ entity }: PoliticalInfoProps) {
  if (!(entity.tags ?? []).includes("politics")) return null;

  const party = inferParty(entity);
  const office = inferOffice(entity);
  const jurisdiction = inferJurisdiction(entity);
  const status = inferStatus(entity);

  // Don't render if we couldn't infer anything useful
  if (!party && !office && !jurisdiction && !status) return null;

  const items: { label: string; value: string; badgeClass?: string }[] = [];
  if (office) items.push({ label: "Office", value: office });
  if (party) items.push({ label: "Party", value: party, badgeClass: PARTY_BADGE[party] });
  if (jurisdiction) items.push({ label: "Jurisdiction", value: jurisdiction });
  if (status) items.push({ label: "Status", value: status, badgeClass: STATUS_BADGE[status] });

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Political Info
      </h2>
      <div className="border border-border/60 rounded-xl bg-card p-4">
        <div className="grid grid-cols-2 gap-3">
          {items.map((item) => (
            <div key={item.label}>
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
                {item.label}
              </div>
              {item.badgeClass ? (
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${item.badgeClass}`}>
                  {item.value}
                </span>
              ) : (
                <span className="text-sm font-medium text-foreground">
                  {item.value}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
