/**
 * Office Parser
 *
 * Extracts structured political office data from politician entity descriptions.
 * Handles US Senators, Representatives, state legislators, governors, and AGs.
 *
 * Description patterns handled:
 *   - "U.S. Senator from Nebraska (R)"
 *   - "U.S. Representative for California's 36th district (D)"
 *   - "U.S. Representative (FL-19)"
 *   - "California State Senator representing District 11"
 *   - "New York State Assemblymember (District 73)"
 *   - "NY State Assemblymember (District 69)"
 *   - "Michigan State Senator (13th district)"
 *   - "New York State Senator (D-Brooklyn)"
 *   - "Governor of California"
 *   - "Texas Attorney General"
 *   - "Former U.S. Representative (IL-8, 2005-2011)"
 */

// ---- Types ----

export type OfficeType =
  | "senator"
  | "representative"
  | "governor"
  | "state_senator"
  | "state_representative"
  | "attorney_general"
  | "other";

export type Party = "democratic" | "republican" | "independent" | "other";

export type OfficeStatus = "incumbent" | "candidate" | "former";

export interface ParsedOffice {
  officeType: OfficeType;
  jurisdiction: string; // Two-letter state code or "US"
  district: string | null;
  party: Party | null;
  status: OfficeStatus;
  termStart: string | null;
  termEnd: string | null;
}

// ---- State name → abbreviation ----

const STATE_ABBREVS: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

// Also support abbreviations as input
const ABBREV_SET = new Set(Object.values(STATE_ABBREVS));

/**
 * Convert a state name or abbreviation to a two-letter abbreviation.
 * Returns null if unrecognized.
 */
export function toStateAbbrev(input: string): string | null {
  const upper = input.trim().toUpperCase();
  if (ABBREV_SET.has(upper)) return upper;
  return STATE_ABBREVS[input.trim().toLowerCase()] ?? null;
}

// ---- Parsing ----

/**
 * Parse a politician entity description into structured office data.
 *
 * Returns null if no office can be inferred from the description.
 * For candidates (e.g. "Republican candidate in TX-9 runoff") or people
 * who ran for office but don't currently hold one, still returns data
 * with an appropriate status.
 */
export function parseOffice(
  description: string,
  entityId: string,
): ParsedOffice | null {
  if (!description) return null;

  // Use first sentence / first 300 chars for primary classification
  // (long descriptions have career history that can confuse the parser)
  const desc = description.slice(0, 500);

  const officeType = inferOfficeType(desc);
  if (!officeType) return null;

  const jurisdiction = inferJurisdiction(desc, officeType);
  const district = inferDistrict(desc, officeType, jurisdiction);
  const party = inferParty(desc);
  const status = inferStatus(desc, officeType);
  const { termStart, termEnd } = inferTermDates(desc);

  return {
    officeType,
    jurisdiction,
    district,
    party,
    status,
    termStart,
    termEnd,
  };
}

// ---- Office type inference ----

function inferOfficeType(desc: string): OfficeType | null {
  // Order matters: check more specific patterns first

  // Federal senators
  if (/U\.?S\.?\s+Senator\b/i.test(desc)) return "senator";

  // Federal representatives
  if (/U\.?S\.?\s+Representative\b/i.test(desc)) return "representative";

  // State senators
  if (/State\s+Senator/i.test(desc)) return "state_senator";

  // State assembly / state representatives
  if (/State\s+Assembl(?:ymember|y\s+Member)/i.test(desc))
    return "state_representative";
  if (/State\s+Representative/i.test(desc)) return "state_representative";

  // Governor
  if (/\bGovernor\b/i.test(desc)) return "governor";

  // Attorney General
  if (/Attorney\s+General/i.test(desc)) return "attorney_general";

  // Candidates for known offices
  if (/candidate\s+(?:for|in)\s+(?:U\.?S\.?\s+)?Senate/i.test(desc))
    return "senator";
  if (/running\s+for\s+(?:U\.?S\.?\s+)?Senate/i.test(desc)) return "senator";
  if (/(?:Senate|senate)\s+(?:primary|nominee|runoff)/i.test(desc))
    return "senator";
  if (/nominee\s+for\s+(?:U\.?S\.?\s+)?Senate/i.test(desc)) return "senator";

  if (/candidate\s+(?:for|in)\s+(?:the\s+)?(?:[A-Z]{2}-\d+|House)/i.test(desc))
    return "representative";
  if (/running\s+for\s+(?:Florida\s+)?Governor/i.test(desc)) return "governor";

  // Candidate with a district code like TX-10, NC-1, NY-12
  if (/\b[A-Z]{2}-\d+\b/.test(desc)) return "representative";

  // Ran for Congress
  if (/Ran for US Congress/i.test(desc)) return "representative";

  return null;
}

// ---- Jurisdiction inference ----

function inferJurisdiction(desc: string, officeType: OfficeType): string {
  // Try state abbreviation patterns: "(R-TX)", "(D-CA)", "(FL-19)"
  const parenAbbrev = desc.match(
    /\(([A-Z])-([A-Z]{2})\)|\(([A-Z]{2})-\d+\)/,
  );
  if (parenAbbrev) {
    const abbr = parenAbbrev[2] || parenAbbrev[3];
    if (abbr && ABBREV_SET.has(abbr)) return abbr;
  }

  // "from STATE" patterns: "Senator from Nebraska", "from Connecticut"
  const fromState = desc.match(
    /from\s+((?:New\s+|North\s+|South\s+|West\s+|Rhode\s+)?[A-Z][a-z]+(?:'s)?)/,
  );
  if (fromState) {
    const stateName = fromState[1].replace(/'s$/, "");
    const abbr = toStateAbbrev(stateName);
    if (abbr) return abbr;
  }

  // "for STATE's Nth district": "Representative for California's 36th district"
  // Also handles "for Illinois' 2nd district" (possessive without s)
  const forState = desc.match(
    /for\s+((?:New\s+|North\s+|South\s+|West\s+|Rhode\s+)?[A-Z][a-z]+(?:'s?)?)\s+\d/,
  );
  if (forState) {
    const stateName = forState[1].replace(/'s?$/, "");
    const abbr = toStateAbbrev(stateName);
    if (abbr) return abbr;
  }

  // "STATE State Senator/Assemblymember": "California State Senator", "NY State Assemblymember"
  const statePrefix = desc.match(
    /((?:New\s+|North\s+|South\s+|West\s+|Rhode\s+)?[A-Z][a-zA-Z]+)\s+State\s+(?:Senator|Assembl)/,
  );
  if (statePrefix) {
    const abbr = toStateAbbrev(statePrefix[1]);
    if (abbr) return abbr;
  }

  // "Governor of STATE": "Governor of California"
  const govOf = desc.match(
    /Governor\s+of\s+((?:New\s+|North\s+|South\s+|West\s+|Rhode\s+)?[A-Z][a-z]+)/,
  );
  if (govOf) {
    const abbr = toStateAbbrev(govOf[1]);
    if (abbr) return abbr;
  }

  // "STATE Attorney General": "Texas Attorney General"
  const agState = desc.match(
    /((?:New\s+|North\s+|South\s+|West\s+|Rhode\s+)?[A-Z][a-z]+)\s+Attorney\s+General/,
  );
  if (agState) {
    const abbr = toStateAbbrev(agState[1]);
    if (abbr) return abbr;
  }

  // District code: "TX-10", "NC-1", "FL-19"
  const districtCode = desc.match(/\b([A-Z]{2})-(\d+)\b/);
  if (districtCode && ABBREV_SET.has(districtCode[1])) {
    return districtCode[1];
  }

  // "in STATE" for candidates: "candidate in the TX-10 primary"
  // (already caught by district code above)

  // "for NC-1", "in NC-4"
  const forDist = desc.match(/(?:for|in)\s+([A-Z]{2})-\d+/);
  if (forDist && ABBREV_SET.has(forDist[1])) return forDist[1];

  // "for STATE Governor": "running for Florida Governor"
  const forGov = desc.match(
    /for\s+((?:New\s+|North\s+|South\s+|West\s+|Rhode\s+)?[A-Z][a-z]+)\s+Governor/,
  );
  if (forGov) {
    const abbr = toStateAbbrev(forGov[1]);
    if (abbr) return abbr;
  }

  // State name anywhere in description (last resort for state-level offices)
  if (
    officeType === "state_senator" ||
    officeType === "state_representative" ||
    officeType === "governor" ||
    officeType === "attorney_general"
  ) {
    for (const [name, abbr] of Object.entries(STATE_ABBREVS)) {
      // Match full state name (case-insensitive, word boundary)
      const pattern = new RegExp(`\\b${name}\\b`, "i");
      if (pattern.test(desc)) return abbr;
    }
  }

  // "in STATE" patterns (broad): "in Michigan 2026", "in Michigan.", "in Oregon with"
  const inState = desc.match(
    /\bin\s+((?:New\s+|North\s+|South\s+|West\s+|Rhode\s+)?[A-Z][a-z]+)(?:\s+\d{4}|\.|,|\s+with|\s+(?:Democratic|Republican|GOP))/,
  );
  if (inState) {
    const abbr = toStateAbbrev(inState[1]);
    if (abbr) return abbr;
  }

  // "for Senate in STATE": "nominee for U.S. Senate in Michigan"
  const forSenateIn = desc.match(
    /Senate\s+in\s+((?:New\s+|North\s+|South\s+|West\s+|Rhode\s+)?[A-Z][a-z]+)/,
  );
  if (forSenateIn) {
    const abbr = toStateAbbrev(forSenateIn[1]);
    if (abbr) return abbr;
  }

  // "Congress in STATE": "Ran for US Congress in Oregon"
  const congressIn = desc.match(
    /Congress\s+in\s+((?:New\s+|North\s+|South\s+|West\s+|Rhode\s+)?[A-Z][a-z]+)/,
  );
  if (congressIn) {
    const abbr = toStateAbbrev(congressIn[1]);
    if (abbr) return abbr;
  }

  // For federal-level offices, default to US if no state found
  if (officeType === "senator" || officeType === "representative") {
    return "US";
  }

  return "US";
}

// ---- District inference ----

function inferDistrict(
  desc: string,
  officeType: OfficeType,
  jurisdiction: string,
): string | null {
  if (officeType === "state_representative" || officeType === "state_senator") {
    // For state legislators, prefer "District NN" and ordinal patterns over XX-NN codes
    // (since XX-NN codes in the description may refer to a different race,
    // e.g. "NY State Assemblymember (District 69) ... successor for NY-12")

    // "District NN": "District 73", "District 69"
    const distNum = desc.match(/District\s+(\d+)/i);
    if (distNum) return `${jurisdiction}-${distNum[1]}`;

    // "13th district", "1st district"
    const ordinalDist = desc.match(/(\d+)(?:st|nd|rd|th)\s+district/i);
    if (ordinalDist) return `${jurisdiction}-${ordinalDist[1]}`;

    return null;
  }

  // Representatives have district codes: "CA-36", "FL-19", "(MI-08)"
  if (officeType === "representative") {
    // XX-NN pattern
    const distCode = desc.match(/\b([A-Z]{2})-(\d+)\b/);
    if (distCode) return distCode[0];

    // "Nth district": "36th district", "4th district", "1st district"
    const ordinalDist = desc.match(/(\d+)(?:st|nd|rd|th)\s+district/i);
    if (ordinalDist) return `${jurisdiction}-${ordinalDist[1]}`;

    // "District NN": "District 73", "District 69"
    const distNum = desc.match(/District\s+(\d+)/i);
    if (distNum) return `${jurisdiction}-${distNum[1]}`;
  }

  return null;
}

// ---- Party inference ----

/**
 * Split description into "early" (first ~2 clauses) and full text.
 * Uses ". " as sentence boundary but skips common abbreviations.
 */
function getEarlyText(desc: string): string {
  // Replace common abbreviations to avoid false sentence breaks
  const safe = desc
    .replace(/U\.S\./g, "US")
    .replace(/D\.C\./g, "DC");
  // Take first two sentences
  const sentences = safe.split(/\.\s+/);
  return sentences.slice(0, 2).join(". ");
}

function inferParty(desc: string): Party | null {
  // Use early text (first ~2 sentences) for party inference to avoid picking up
  // opponent references like "Faces incumbent Don Davis (D) in general election."
  const early = getEarlyText(desc);

  // Explicit party indicators in parentheses: "(D)", "(R)", "(D-CA)", "(R-TX)", "(R, since 2002)", "(D-Brooklyn)"
  if (/\(D(?:\s*[-,]\s*[A-Za-z0-9 ]+)?\)/.test(early)) return "democratic";
  if (/\(R(?:\s*[-,]\s*[A-Za-z0-9 ]+)?\)/.test(early)) return "republican";
  if (/\(I(?:\s*[-,]\s*[A-Za-z0-9 ]+)?\)/.test(early)) return "independent";

  // Party words in early text
  if (/\bDemocrat(?:ic)?\b/i.test(early)) return "democratic";
  if (/\bRepublican\b/i.test(early)) return "republican";
  if (/\bIndependent\b/i.test(early)) return "independent";

  // Broader search — check full description for party-in-context patterns
  // (NOT bare parenthetical abbreviations, which could refer to opponents).
  if (/\bDemocrat(?:ic)?\s+(?:primary|candidate|challenger|senator|representative|nominee)/i.test(desc))
    return "democratic";
  if (/\bRepublican\s+(?:primary|candidate|challenger|senator|representative|nominee)/i.test(desc))
    return "republican";
  if (/\b(?:centrist|leading|moderate)\s+Democrat/i.test(desc)) return "democratic";
  if (/\b(?:centrist|leading|moderate)\s+Republican/i.test(desc)) return "republican";

  // Freedom Caucus = Republican
  if (/Freedom Caucus/i.test(desc)) return "republican";

  // GOP = Republican
  if (/\bGOP\b/.test(desc)) return "republican";

  return null;
}

// ---- Status inference ----

function inferStatus(desc: string, officeType: OfficeType): OfficeStatus {
  // Only mark as "former" if the description LEADS with "Former" — i.e., the primary
  // office is former. "U.S. Senator from Nebraska (R). Former Governor." should be
  // incumbent (senator), not former (the "Former" applies to a different office).
  if (/^Former\b/i.test(desc)) return "former";

  // "Former X" only counts as former if the "Former" applies to the SAME office type
  // we're parsing. "U.S. Senator ... Former Governor." = incumbent senator, not former.
  const early = getEarlyText(desc);

  // Build a pattern that matches "former" only for the specific office type we detected
  const officeNames: Record<OfficeType, string[]> = {
    senator: ["Senator", "US Senator", "U\\.S\\. Senator"],
    representative: ["Representative", "US Representative", "U\\.S\\. Representative"],
    governor: ["Governor"],
    state_senator: ["State Senator"],
    state_representative: ["State Assembl", "State Representative"],
    attorney_general: ["Attorney General"],
    other: [],
  };
  const patterns = officeNames[officeType];
  if (patterns.length > 0) {
    const officePattern = new RegExp(`\\bformer\\s+(?:${patterns.join("|")})`, "i");
    if (officePattern.test(early)) return "former";
  }

  // Lost election (in early text)
  if (/\bLost\s+\d{4}\b/i.test(early)) return "former";
  if (/\blost\s+.*\bprimary\b/i.test(early)) return "former";

  // Resigned (in early text)
  if (/\bResigned\b/i.test(early)) return "former";

  // Candidates: "candidate in/for", "running for", "nominee for"
  if (/\bcandidate\s+(?:for|in)\b/i.test(desc)) return "candidate";
  if (/\brunning\s+for\b/i.test(desc)) return "candidate";
  if (/\bnominee\s+for\b/i.test(desc)) return "candidate";
  if (/\bprimary\b.*\b(?:candidate|challenger)\b/i.test(desc))
    return "candidate";
  if (/\bchallenger\b.*\bprimary\b/i.test(desc)) return "candidate";

  // Holding office indicators
  if (
    /U\.?S\.?\s+(?:Senator|Representative)\s+(?:for|from)\b/i.test(desc)
  )
    return "incumbent";
  if (/\bis\s+(?:the\s+)?Governor\b/i.test(desc)) return "incumbent";
  if (/\bState\s+(?:Senator|Assembl)/i.test(desc) && !/former/i.test(desc))
    return "incumbent";
  if (/Attorney\s+General\s+\(since/i.test(desc)) return "incumbent";

  // "Senate Majority Leader", "Chair of" etc. suggest incumbent
  if (/\b(?:Chair|Leader|Whip|Ranking)\b/i.test(desc)) return "incumbent";

  // For office types that imply current service
  if (
    officeType === "senator" ||
    officeType === "representative" ||
    officeType === "state_senator" ||
    officeType === "state_representative"
  ) {
    // If description starts with "U.S. Senator" or similar, likely incumbent
    if (/^(?:U\.?S\.?\s+)?(?:Senator|Representative)\b/i.test(desc))
      return "incumbent";
  }

  return "candidate";
}

// ---- Term date inference ----

function inferTermDates(desc: string): {
  termStart: string | null;
  termEnd: string | null;
} {
  // "(1995-2012)", "(since 2015)", "(2005-2011)"
  const rangeMatch = desc.match(/\((\d{4})-(\d{4})\)/);
  if (rangeMatch) {
    return { termStart: rangeMatch[1], termEnd: rangeMatch[2] };
  }

  const sinceMatch = desc.match(/\(since\s+(\d{4})\)/);
  if (sinceMatch) {
    return { termStart: sinceMatch[1], termEnd: null };
  }

  // "since 2002" in text
  const sinceText = desc.match(/since\s+(\d{4})/);
  if (sinceText) {
    return { termStart: sinceText[1], termEnd: null };
  }

  return { termStart: null, termEnd: null };
}
