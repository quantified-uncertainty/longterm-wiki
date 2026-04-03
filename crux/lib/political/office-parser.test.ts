import { describe, it, expect } from "vitest";
import { parseOffice, toStateAbbrev } from "./office-parser.ts";

describe("toStateAbbrev", () => {
  it("converts full state names", () => {
    expect(toStateAbbrev("California")).toBe("CA");
    expect(toStateAbbrev("New York")).toBe("NY");
    expect(toStateAbbrev("North Carolina")).toBe("NC");
    expect(toStateAbbrev("South Dakota")).toBe("SD");
  });

  it("passes through valid abbreviations", () => {
    expect(toStateAbbrev("CA")).toBe("CA");
    expect(toStateAbbrev("TX")).toBe("TX");
    expect(toStateAbbrev("NY")).toBe("NY");
  });

  it("returns null for unrecognized input", () => {
    expect(toStateAbbrev("")).toBeNull();
    expect(toStateAbbrev("Atlantis")).toBeNull();
    expect(toStateAbbrev("XX")).toBeNull();
  });

  it("is case-insensitive for state names", () => {
    expect(toStateAbbrev("california")).toBe("CA");
    expect(toStateAbbrev("new york")).toBe("NY");
  });
});

describe("parseOffice", () => {
  describe("US Senators", () => {
    it("parses 'U.S. Senator from STATE (PARTY)'", () => {
      const result = parseOffice(
        "U.S. Senator from Nebraska (R). Former Governor.",
        "pete-ricketts",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("senator");
      expect(result!.jurisdiction).toBe("NE");
      expect(result!.party).toBe("republican");
      expect(result!.status).toBe("incumbent");
      expect(result!.district).toBeNull();
    });

    it("parses 'U.S. Senator from Connecticut (D)'", () => {
      const result = parseOffice(
        "U.S. Senator from Connecticut (D). As Chair of the Senate Judiciary Subcommittee on Privacy...",
        "richard-blumenthal",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("senator");
      expect(result!.jurisdiction).toBe("CT");
      expect(result!.party).toBe("democratic");
      expect(result!.status).toBe("incumbent");
    });

    it("parses senator with 'since YEAR'", () => {
      const result = parseOffice(
        "Four-term U.S. Senator from Texas (R, since 2002). Former Senate Majority Whip.",
        "john-cornyn",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("senator");
      expect(result!.jurisdiction).toBe("TX");
      expect(result!.party).toBe("republican");
      expect(result!.termStart).toBe("2002");
    });

    it("parses Senate Majority Leader", () => {
      const result = parseOffice(
        "U.S. Senator from South Dakota (R), Senate Majority Leader. Co-introduced the AI Research...",
        "john-thune",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("senator");
      expect(result!.jurisdiction).toBe("SD");
      expect(result!.party).toBe("republican");
      expect(result!.status).toBe("incumbent");
    });

    it("parses Senate Minority Leader", () => {
      const result = parseOffice(
        "U.S. Senator from New York (D), Senate Minority Leader. Launched the SAFE Innovation Framework...",
        "chuck-schumer",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("senator");
      expect(result!.jurisdiction).toBe("NY");
      expect(result!.party).toBe("democratic");
      expect(result!.status).toBe("incumbent");
    });
  });

  describe("US Representatives", () => {
    it("parses 'U.S. Representative for STATE's Nth district (PARTY)'", () => {
      const result = parseOffice(
        "U.S. Representative for California's 36th district (D). Co-chair of the House Bipartisan Task Force on AI.",
        "ted-lieu",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("CA");
      expect(result!.district).toBe("CA-36");
      expect(result!.party).toBe("democratic");
      expect(result!.status).toBe("incumbent");
    });

    it("parses 'U.S. Representative for North Carolina's 1st district (D)'", () => {
      const result = parseOffice(
        "U.S. Representative for North Carolina's 1st district (D). Air Force veteran, pastor...",
        "don-davis",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("NC");
      expect(result!.district).toBe("NC-1");
      expect(result!.party).toBe("democratic");
    });

    it("parses 'U.S. Representative for New Jersey's 5th district (D)'", () => {
      const result = parseOffice(
        "U.S. Representative for New Jersey's 5th district (D). Five-term centrist Democrat...",
        "josh-gottheimer",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("NJ");
      expect(result!.district).toBe("NJ-5");
    });

    it("parses representative with explicit district code (FL-19)", () => {
      const result = parseOffice(
        "U.S. Representative (FL-19) running for Florida Governor in 2026. Freedom Caucus member.",
        "byron-donalds",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("FL");
      expect(result!.district).toBe("FL-19");
      expect(result!.party).toBe("republican");
    });

    it("parses former representative with date range", () => {
      const result = parseOffice(
        "Former U.S. Representative for Illinois' 2nd district (1995-2012). Lost 2026 Democratic primary comeback attempt...",
        "jesse-jackson-jr",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("IL");
      expect(result!.district).toBe("IL-2");
      expect(result!.status).toBe("former");
      expect(result!.termStart).toBe("1995");
      expect(result!.termEnd).toBe("2012");
    });

    it("parses former representative with compact district code", () => {
      const result = parseOffice(
        "Former 3-term U.S. Representative (IL-8, 2005-2011) who won the 2026 Democratic primary...",
        "melissa-bean",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("IL");
      expect(result!.district).toBe("IL-8");
      expect(result!.party).toBe("democratic");
    });
  });

  describe("State legislators", () => {
    it("parses California State Senator", () => {
      const result = parseOffice(
        "Scott Wiener is a California State Senator representing District 11 (San Francisco).",
        "scott-wiener",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("state_senator");
      expect(result!.jurisdiction).toBe("CA");
      expect(result!.district).toBe("CA-11");
    });

    it("parses New York State Assemblymember", () => {
      const result = parseOffice(
        "New York State Assemblymember (District 73) and former Palantir engineer.",
        "alex-bores",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("state_representative");
      expect(result!.jurisdiction).toBe("NY");
      expect(result!.district).toBe("NY-73");
    });

    it("parses NY State Assemblymember (abbreviation)", () => {
      const result = parseOffice(
        "NY State Assemblymember (District 69) and Jerry Nadler's endorsed successor for NY-12.",
        "micah-lasher",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("state_representative");
      expect(result!.jurisdiction).toBe("NY");
      expect(result!.district).toBe("NY-69");
    });

    it("parses Michigan State Senator", () => {
      const result = parseOffice(
        "Michigan State Senator (13th district) and Senate Majority Whip...",
        "mallory-mcmorrow",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("state_senator");
      expect(result!.jurisdiction).toBe("MI");
      expect(result!.district).toBe("MI-13");
    });

    it("parses New York State Senator", () => {
      const result = parseOffice(
        "New York State Senator (D-Brooklyn). Co-authored the RAISE Act...",
        "andrew-gounardes",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("state_senator");
      expect(result!.jurisdiction).toBe("NY");
      expect(result!.party).toBe("democratic");
    });
  });

  describe("Governors", () => {
    it("parses 'Governor of California'", () => {
      const result = parseOffice(
        "Gavin Newsom is the Governor of California. He vetoed SB 1047...",
        "gavin-newsom",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("governor");
      expect(result!.jurisdiction).toBe("CA");
      expect(result!.status).toBe("incumbent");
    });

    it("parses former governor", () => {
      const result = parseOffice(
        "Former two-term Governor of North Carolina (2017-2025) and four-term Attorney General (2001-2017).",
        "roy-cooper",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("governor");
      expect(result!.jurisdiction).toBe("NC");
      expect(result!.status).toBe("former");
    });
  });

  describe("Attorney General", () => {
    it("parses state AG", () => {
      const result = parseOffice(
        "Texas Attorney General (since 2015) challenging John Cornyn in 2026 GOP Senate primary runoff.",
        "ken-paxton",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("attorney_general");
      expect(result!.jurisdiction).toBe("TX");
      expect(result!.termStart).toBe("2015");
    });
  });

  describe("Candidates", () => {
    it("parses candidate in district primary", () => {
      const result = parseOffice(
        "Republican candidate in the TX-10 primary (2026). Anti-regulation stance on AI policy.",
        "jake-gober",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("TX");
      expect(result!.district).toBe("TX-10");
      expect(result!.party).toBe("republican");
      expect(result!.status).toBe("candidate");
    });

    it("parses candidate in NY-12 primary", () => {
      const result = parseOffice(
        "Candidate in the NY-12 Democratic primary (2026). Grandson of President JFK.",
        "jack-schlossberg",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("NY");
      expect(result!.district).toBe("NY-12");
      expect(result!.party).toBe("democratic");
      expect(result!.status).toBe("candidate");
    });

    it("parses Republican nominee for Senate", () => {
      const result = parseOffice(
        "Republican nominee for U.S. Senate in Michigan. Former FBI special agent...",
        "mike-rogers-mi",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("senator");
      expect(result!.jurisdiction).toBe("MI");
      expect(result!.party).toBe("republican");
      expect(result!.status).toBe("candidate");
    });

    it("parses Senate nominee by description", () => {
      const result = parseOffice(
        "Republican nominee for U.S. Senate in North Carolina (2026) against Roy Cooper.",
        "michael-whatley",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("senator");
      expect(result!.party).toBe("republican");
      expect(result!.status).toBe("candidate");
    });

    it("parses running for Governor", () => {
      const result = parseOffice(
        "U.S. Senator from Tennessee, running for Governor in 2026. Leading Republican on AI policy...",
        "marsha-blackburn",
      );
      // Should detect primary office as senator, since it appears first
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("senator");
      expect(result!.jurisdiction).toBe("TN");
    });

    it("parses candidate for NC-1", () => {
      const result = parseOffice(
        "Republican candidate for NC-1. Retired Army Colonel (26 years)...",
        "laurie-buckhout",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("NC");
      expect(result!.district).toBe("NC-1");
      expect(result!.party).toBe("republican");
      expect(result!.status).toBe("candidate");
    });
  });

  describe("Edge cases", () => {
    it("returns null for empty description", () => {
      expect(parseOffice("", "test")).toBeNull();
    });

    it("returns null for non-political description", () => {
      expect(
        parseOffice(
          "AI policy researcher. Previously at RAND. Ran for US Congress in Oregon.",
          "carrick-flynn",
        ),
      ).not.toBeNull(); // "Ran for US Congress" should still match
    });

    it("handles policy researcher who ran for Congress", () => {
      const result = parseOffice(
        "AI policy researcher. Previously at RAND. Ran for US Congress in Oregon with support from Protect Our Future (SBF-funded PAC).",
        "carrick-flynn",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("OR");
    });

    it("handles progressive challenger in primary", () => {
      const result = parseOffice(
        "Durham County Commissioner and progressive challenger in NC-4 Democratic primary (2026).",
        "nida-allam",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("NC");
      expect(result!.district).toBe("NC-4");
      expect(result!.party).toBe("democratic");
      expect(result!.status).toBe("candidate");
    });

    it("handles runoff candidate with district code", () => {
      const result = parseOffice(
        "Republican candidate in TX-9 runoff (May 26, 2026). West Point graduate...",
        "alex-mealer",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("TX");
      expect(result!.district).toBe("TX-9");
      expect(result!.party).toBe("republican");
      expect(result!.status).toBe("candidate");
    });

    it("handles three-term representative running for Senate", () => {
      const result = parseOffice(
        "Three-term U.S. Representative (MI-11) running for U.S. Senate in Michigan 2026 Democratic primary.",
        "haley-stevens",
      );
      expect(result).not.toBeNull();
      expect(result!.officeType).toBe("representative");
      expect(result!.jurisdiction).toBe("MI");
      expect(result!.district).toBe("MI-11");
    });
  });
});
