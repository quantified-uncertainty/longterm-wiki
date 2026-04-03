import { describe, it, expect } from "vitest";
import { resolveStakeholderName, type EntityRecord } from "./stakeholder-resolver.ts";

// Build a minimal lookup for testing
function buildTestLookup(): Map<string, EntityRecord> {
  const lookup = new Map<string, EntityRecord>();

  const entities: EntityRecord[] = [
    { id: "ted-cruz", stableId: "sid_2m4yjRwAHA", title: "Ted Cruz", aliases: [], type: "person" },
    { id: "amy-klobuchar", stableId: "sid_uk5EhXsfmN", title: "Amy Klobuchar", aliases: [], type: "person" },
    { id: "andrew-gounardes", stableId: "sid_yvtkoSDQm-", title: "Andrew Gounardes", aliases: [], type: "person" },
    { id: "alex-bores", stableId: "sid_W2B4vrLpsU", title: "Alex Bores", aliases: [], type: "person" },
    { id: "mike-rounds", stableId: "sid_c3jsITFMPU", title: "Mike Rounds", aliases: [], type: "person" },
    { id: "mark-warner", stableId: "sid_hXFxf2aOHZ", title: "Mark Warner", aliases: [], type: "person" },
    { id: "apple", stableId: "sid_1kawFEPpVe", title: "Apple", aliases: [], type: "organization" },
    { id: "nvidia", stableId: "sid_UvpZCnW3wA", title: "Nvidia", aliases: [], type: "organization" },
    { id: "baidu", stableId: "sid_Z1ypUKIPc0", title: "Baidu", aliases: [], type: "organization" },
    {
      id: "center-for-democracy-and-technology",
      stableId: "sid_XkqcWk46oQ",
      title: "Center for Democracy and Technology",
      aliases: ["CDT"],
      type: "organization",
    },
    {
      id: "electronic-frontier-foundation",
      stableId: "sid_H4tplAyDRX",
      title: "Electronic Frontier Foundation (EFF)",
      aliases: ["EFF"],
      type: "organization",
    },
    {
      id: "semiconductor-industry-association",
      stableId: "sid_ezdMt069kA",
      title: "Semiconductor Industry Association",
      aliases: ["SIA"],
      type: "organization",
    },
    {
      id: "bureau-of-industry-and-security",
      stableId: "sid_K1hxe7b9SA",
      title: "Bureau of Industry and Security",
      aliases: ["BIS"],
      type: "organization",
    },
    {
      id: "european-commission",
      stableId: "sid_3zsTSX6SFK",
      title: "European Commission",
      aliases: [],
      type: "organization",
    },
    {
      id: "google",
      stableId: "sid_cMNszJMTPX",
      title: "Google / Alphabet",
      aliases: ["Google", "Alphabet"],
      type: "organization",
    },
    {
      id: "microsoft",
      stableId: "sid_OIY5gaPpBA",
      title: "Microsoft AI",
      aliases: ["Microsoft"],
      type: "organization",
    },
    {
      id: "cset",
      stableId: "sid_lvsDuyzPcg",
      title: "CSET (Center for Security and Emerging Technology)",
      aliases: ["CSET"],
      type: "organization",
    },
    {
      id: "access-now",
      stableId: "sid_DHWH2M0Ega",
      title: "Access Now",
      aliases: [],
      type: "organization",
    },
    {
      id: "r-street-institute",
      stableId: "sid_yfAYuNTKxQ",
      title: "R Street Institute",
      aliases: [],
      type: "organization",
    },
    {
      id: "leading-the-future",
      stableId: "sid_pg7Ym4EQ9A",
      title: "Leading the Future super PAC",
      aliases: ["Leading the Future"],
      type: "organization",
    },
    {
      id: "public-first-action",
      stableId: "sid_NeUHBH9hGa",
      title: "Public First Action",
      aliases: [],
      type: "organization",
    },
  ];

  for (const e of entities) {
    // By normalized title
    lookup.set(e.title.toLowerCase(), e);
    // By slug
    lookup.set(e.id.toLowerCase(), e);
    // By aliases
    for (const alias of e.aliases) {
      lookup.set(alias.toLowerCase(), e);
    }
  }

  return lookup;
}

describe("resolveStakeholderName", () => {
  const lookup = buildTestLookup();

  describe("exact matches", () => {
    it("matches exact entity title", () => {
      const result = resolveStakeholderName("Apple", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("apple");
      expect(result!.method).toBe("exact");
    });

    it("matches exact alias", () => {
      const result = resolveStakeholderName("Google", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("google");
      expect(result!.method).toBe("exact");
    });

    it("matches Baidu exactly", () => {
      const result = resolveStakeholderName("Baidu", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("baidu");
    });

    it("matches European Commission", () => {
      const result = resolveStakeholderName("European Commission", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("european-commission");
    });
  });

  describe("title-strip matches", () => {
    it("strips 'Senator' prefix", () => {
      const result = resolveStakeholderName("Senator Ted Cruz", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("ted-cruz");
      expect(result!.method).toBe("title-strip");
    });

    it("strips 'Sen.' prefix", () => {
      const result = resolveStakeholderName("Sen. Mike Rounds", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("mike-rounds");
      expect(result!.method).toBe("title-strip");
    });

    it("strips 'Rep.' prefix (no match if entity not found)", () => {
      const result = resolveStakeholderName("Rep. Bill Huizenga", lookup);
      expect(result).toBeNull(); // No entity for Bill Huizenga
    });

    it("strips 'Assemblymember' prefix", () => {
      const result = resolveStakeholderName("Assemblymember Alex Bores", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("alex-bores");
      expect(result!.method).toBe("title-strip");
    });

    it("strips 'Senator' from 'Senator Andrew Gounardes'", () => {
      const result = resolveStakeholderName("Senator Andrew Gounardes", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("andrew-gounardes");
    });

    it("strips 'Senator Amy Klobuchar'", () => {
      const result = resolveStakeholderName("Senator Amy Klobuchar", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("amy-klobuchar");
    });
  });

  describe("parenthetical-strip matches", () => {
    it("strips '(SIA)' from Semiconductor Industry Association", () => {
      const result = resolveStakeholderName("Semiconductor Industry Association (SIA)", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("semiconductor-industry-association");
      expect(result!.method).toBe("paren-strip");
    });

    it("strips '(BIS)' from Bureau of Industry and Security", () => {
      const result = resolveStakeholderName("Bureau of Industry and Security (BIS)", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("bureau-of-industry-and-security");
      expect(result!.method).toBe("paren-strip");
    });
  });

  describe("ampersand matches", () => {
    it("resolves '&' to 'and' in 'Center for Democracy & Technology'", () => {
      const result = resolveStakeholderName("Center for Democracy & Technology", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("center-for-democracy-and-technology");
      expect(result!.method).toBe("ampersand");
    });
  });

  describe("before-paren matches", () => {
    it("matches CSET from 'CSET (Georgetown)'", () => {
      const result = resolveStakeholderName("CSET (Georgetown)", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("cset");
      // CSET's full title includes "(Center for Security and Emerging Technology)",
      // so "CSET" alone (after paren-strip) matches the alias. Either paren-strip
      // or before-paren is acceptable — both resolve correctly.
      expect(["paren-strip", "before-paren"]).toContain(result!.method);
    });
  });

  describe("backed-strip matches", () => {
    it("strips '(Anthropic-backed)' from 'Public First Action (Anthropic-backed)'", () => {
      const result = resolveStakeholderName("Public First Action (Anthropic-backed)", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("public-first-action");
      // Could match via paren-strip or backed-strip
      expect(["paren-strip", "backed-strip"]).toContain(result!.method);
    });
  });

  describe("suffix-strip matches", () => {
    it("strips 'coalition' from 'R Street Institute coalition'", () => {
      const result = resolveStakeholderName("R Street Institute coalition", lookup);
      expect(result).not.toBeNull();
      expect(result!.entity.id).toBe("r-street-institute");
      expect(result!.method).toBe("suffix-strip");
    });
  });

  describe("unresolvable names", () => {
    it("returns null for generic groups", () => {
      expect(resolveStakeholderName("AI safety researchers", lookup)).toBeNull();
      expect(resolveStakeholderName("113+ AI Company Employees", lookup)).toBeNull();
      expect(resolveStakeholderName("Trump Administration", lookup)).toBeNull();
      expect(resolveStakeholderName("50 Republican House Members", lookup)).toBeNull();
    });

    it("returns null for entities not in the database", () => {
      expect(resolveStakeholderName("Nancy Pelosi", lookup)).toBeNull();
      expect(resolveStakeholderName("IBM", lookup)).toBeNull();
      expect(resolveStakeholderName("Amazon", lookup)).toBeNull();
    });
  });
});
