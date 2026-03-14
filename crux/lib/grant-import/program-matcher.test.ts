import { describe, it, expect } from "vitest";
import {
  matchProgram,
  PROGRAM_IDS,
  getAllProgramIds,
} from "./program-matcher.ts";

describe("matchProgram", () => {
  // ---- EA Funds ----

  it("matches Long-Term Future Fund grants", () => {
    const result = matchProgram({
      source: "ea-funds",
      funderId: "yA12C1KcjQ", // LTFF entity ID
      focusArea: "Long-Term Future Fund",
      name: "Grant to MIRI",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.LTFF_GRANTS);
  });

  it("matches Animal Welfare Fund grants", () => {
    const result = matchProgram({
      source: "ea-funds",
      funderId: "gNsqAes7Dw", // CEA entity ID
      focusArea: "Animal Welfare Fund",
      name: "Grant to Sentience Institute",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.AWF_GRANTS);
  });

  it("matches EA Infrastructure Fund grants", () => {
    const result = matchProgram({
      source: "ea-funds",
      funderId: "gNsqAes7Dw",
      focusArea: "EA Infrastructure Fund",
      name: "Grant to CEA",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.EAIF_GRANTS);
  });

  it("matches Effective Altruism Infrastructure Fund variant", () => {
    const result = matchProgram({
      source: "ea-funds",
      funderId: "gNsqAes7Dw",
      focusArea: "Effective Altruism Infrastructure Fund",
      name: "Grant to 80k",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.EAIF_GRANTS);
  });

  it("matches Global Health and Development Fund grants", () => {
    const result = matchProgram({
      source: "ea-funds",
      funderId: "gNsqAes7Dw",
      focusArea: "Global Health and Development Fund",
      name: "Grant to AMF",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.GHD_GRANTS);
  });

  // ---- Coefficient Giving (Open Philanthropy) ----

  it("matches Navigating Transformative AI to AI safety", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Navigating Transformative AI",
      name: "MIRI general support",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.OP_AI_SAFETY);
  });

  it("matches legacy 'Potential Risks from Advanced AI' to AI safety", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Potential Risks from Advanced AI",
      name: "MIRI general support",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.OP_AI_SAFETY);
  });

  it("matches OP biosecurity grants", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Biosecurity & Pandemic Preparedness",
      name: "NTI Bio support",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.OP_BIOSECURITY);
  });

  it("matches farm animal welfare to specific program", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Farm Animal Welfare",
      name: "Good Food Institute",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_FARM_ANIMAL_WELFARE);
  });

  it("matches Science Supporting Biosecurity to biosecurity", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Science Supporting Biosecurity and Pandemic Preparedness",
      name: "IARPA project",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.OP_BIOSECURITY);
  });

  it("matches Farm Animal Welfare grants", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Farm Animal Welfare",
      name: "Good Food Institute",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_FARM_ANIMAL_WELFARE);
  });

  it("matches Broiler Chicken Welfare to farm animal welfare", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Broiler Chicken Welfare",
      name: "Humane Society campaign",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_FARM_ANIMAL_WELFARE);
  });

  it("matches Cage-Free Reforms to farm animal welfare", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Cage-Free Reforms",
      name: "Corporate campaign",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_FARM_ANIMAL_WELFARE);
  });

  it("matches Alternatives to Animal Products to farm animal welfare", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Alternatives to Animal Products",
      name: "Alt protein research",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_FARM_ANIMAL_WELFARE);
  });

  it("matches Criminal Justice Reform to dedicated program", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Criminal Justice Reform",
      name: "Vera Institute support",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.OP_CRIMINAL_JUSTICE);
  });

  it("matches Global Catastrophic Risks to GCR program", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Global Catastrophic Risks Capacity Building",
      name: "EA community support",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_GCR_OPPORTUNITIES);
  });

  it("matches Effective Giving & Careers to dedicated program", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Effective Giving & Careers",
      name: "80,000 Hours support",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_EFFECTIVE_GIVING);
  });

  it("matches Forecasting to dedicated program", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Forecasting",
      name: "Metaculus support",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_FORECASTING);
  });

  it("matches Abundance & Growth to dedicated program", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Abundance & Growth",
      name: "Innovation policy",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_ABUNDANCE_GROWTH);
  });

  it("matches Innovation Policy to abundance & growth", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Innovation Policy",
      name: "Tech policy project",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_ABUNDANCE_GROWTH);
  });

  it("matches Scientific Research to science & health R&D", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Scientific Research",
      name: "Research grant",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_SCIENCE_RD);
  });

  it("matches Global Health R&D to science & health R&D", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Global Health R&D",
      name: "Vaccine research",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_SCIENCE_RD);
  });

  it("matches GiveWell-Recommended Charities to global health", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "GiveWell-Recommended Charities",
      name: "AMF grant",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.OP_GLOBAL_HEALTH);
  });

  it("matches South Asian Air Quality to air quality program", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "South Asian Air Quality",
      name: "Air quality research",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_AIR_QUALITY);
  });

  it("matches Global Aid Policy to global aid program", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Global Aid Policy",
      name: "Policy research",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_GLOBAL_AID);
  });

  it("matches GCR opportunities", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Global Catastrophic Risks",
      name: "Some GCR grant",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_GCR_OPPORTUNITIES);
  });

  it("matches science and global health R&D", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Science and Global Health R&D",
      name: "Vaccine research",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_SCIENCE_RD);
  });

  it("matches scientific research to science R&D", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Scientific Research",
      name: "Lab equipment",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_SCIENCE_RD);
  });

  it("matches forecasting grants", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Forecasting",
      name: "Metaculus support",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_FORECASTING);
  });

  it("matches effective giving grants", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Effective Giving",
      name: "CEA support",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_EFFECTIVE_GIVING);
  });

  it("matches EA community building to effective giving", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Effective Altruism Community Building",
      name: "Local group support",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_EFFECTIVE_GIVING);
  });

  it("matches global aid policy grants", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Global Aid Policy",
      name: "Aid advocacy",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_GLOBAL_AID);
  });

  it("matches U.S. policy to global aid", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "U.S. Policy",
      name: "Policy research",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_GLOBAL_AID);
  });

  it("matches global economic growth grants", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Global Economic Growth",
      name: "Growth research",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_GLOBAL_GROWTH);
  });

  it("matches air quality grants", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "South Asian Air Quality",
      name: "Air quality monitoring",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_AIR_QUALITY);
  });

  it("matches lead exposure grants", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Lead Exposure",
      name: "LEAF grant",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_LEAF);
  });

  it("matches abundance grants", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Abundance and Growth",
      name: "Innovation grant",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_ABUNDANCE_GROWTH);
  });

  it("matches technical AI safety RFP", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Technical AI Safety RFP",
      name: "Alignment research",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.CG_TECHNICAL_AI_SAFETY_RFP);
  });

  it("falls back to OP_GLOBAL_HEALTH for unrecognized CG focus areas", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: "Some New Focus Area",
      name: "Miscellaneous grant",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.OP_GLOBAL_HEALTH);
  });

  it("falls back to OP_GLOBAL_HEALTH for CG grants with no focus area", () => {
    const result = matchProgram({
      source: "coefficient-giving",
      funderId: "ULjDXpSLCI",
      focusArea: null,
      name: "Miscellaneous grant",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.OP_GLOBAL_HEALTH);
  });

  // ---- SFF ----

  it("matches SFF grants to S-Process by default", () => {
    const result = matchProgram({
      source: "sff",
      funderId: "sIFjGbxVct",
      focusArea: null,
      name: "Grant to MIRI",
      description: "Round: SFF-2024-H1; Source: SFF",
    });
    expect(result).toBe(PROGRAM_IDS.SFF_S_PROCESS);
  });

  it("matches SFF speculation grants", () => {
    const result = matchProgram({
      source: "sff",
      funderId: "sIFjGbxVct",
      focusArea: null,
      name: "Grant to MIRI",
      description: "Round: SFF-2024 Speculation; Source: SFF",
    });
    expect(result).toBe(PROGRAM_IDS.SFF_SPECULATION);
  });

  // ---- FTX Future Fund ----

  it("matches FTX regrants", () => {
    const result = matchProgram({
      source: "ftx-future-fund",
      funderId: "JhIGCaI3Ng",
      focusArea: "AI Safety; regrant",
      name: "Grant to Redwood Research",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.FTX_REGRANTING);
  });

  it("matches FTX general grants", () => {
    const result = matchProgram({
      source: "ftx-future-fund",
      funderId: "JhIGCaI3Ng",
      focusArea: "AI Safety",
      name: "Grant to MIRI",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.FTX_GENERAL);
  });

  // ---- Manifund ----

  it("matches Manifund grants to regranting", () => {
    const result = matchProgram({
      source: "manifund",
      funderId: "fFVOuFZCRf",
      focusArea: "AI Safety",
      name: "Some project",
      description: null,
    });
    expect(result).toBe(PROGRAM_IDS.MANIFUND_REGRANTING);
  });

  // ---- ACX Grants ----

  it("matches ACX 2021 round", () => {
    const result = matchProgram({
      source: "acx-grants",
      funderId: "LBr3ocKKyQ",
      focusArea: null,
      name: "Some project",
      description: "ACX Grants 2021 round",
    });
    expect(result).toBe(PROGRAM_IDS.ACX_2022);
  });

  it("matches ACX 2024 round", () => {
    const result = matchProgram({
      source: "acx-grants",
      funderId: "LBr3ocKKyQ",
      focusArea: null,
      name: "Some project",
      description: "ACX Grants 2024 round",
    });
    expect(result).toBe(PROGRAM_IDS.ACX_2023);
  });

  it("matches ACX 2025 round", () => {
    const result = matchProgram({
      source: "acx-grants",
      funderId: "LBr3ocKKyQ",
      focusArea: null,
      name: "Some project",
      description: "ACX Grants 2025 round",
    });
    expect(result).toBe(PROGRAM_IDS.ACX_2025);
  });

  it("returns null for unrecognized ACX rounds", () => {
    const result = matchProgram({
      source: "acx-grants",
      funderId: "LBr3ocKKyQ",
      focusArea: null,
      name: "Some project",
      description: "ACX Grants 2030 round",
    });
    expect(result).toBeNull();
  });

  // ---- Unknown sources ----

  it("returns null for unknown sources", () => {
    const result = matchProgram({
      source: "unknown-source",
      funderId: "someId12345",
      focusArea: null,
      name: "Some grant",
      description: null,
    });
    expect(result).toBeNull();
  });

  it("returns null for GiveWell (no program defined)", () => {
    const result = matchProgram({
      source: "givewell",
      funderId: "OwXl35e7bg",
      focusArea: "Global Health",
      name: "AMF grant",
      description: null,
    });
    expect(result).toBeNull();
  });
});

describe("getAllProgramIds", () => {
  it("returns all unique program IDs", () => {
    const ids = getAllProgramIds();
    expect(ids.length).toBeGreaterThan(0);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("returns 10-char IDs", () => {
    for (const id of getAllProgramIds()) {
      expect(id).toHaveLength(10);
    }
  });
});

describe("PROGRAM_IDS", () => {
  it("has no duplicate IDs", () => {
    const ids = Object.values(PROGRAM_IDS);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
