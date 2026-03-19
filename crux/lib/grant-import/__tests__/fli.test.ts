import { describe, it, expect } from "vitest";
import { parseFLISQLFile } from "../sources/fli.ts";

describe("parseFLISQLFile", () => {
  it("extracts basic grant from SQL INSERT", () => {
    const sql = `insert into donations (donor, donee, donation_earmark,
        amount, donation_date,
        donation_date_precision, donation_date_basis, cause_area, url,
        donor_cause_area_url, notes, affected_countries, affected_states,
        affected_cities, affected_regions) values
    ('Future of Life Institute','Stanford University','Alex Aiken',100813.0,'2015-09-01','day','donation log','AI safety','https://futureoflife.org/AI/2015awardees#Aiken',NULL,'A project grant. Project title: Alex Aiken.',NULL,NULL,NULL,NULL);`;

    const grants = parseFLISQLFile(sql);
    expect(grants.length).toBe(1);
    expect(grants[0].donee).toBe("Stanford University");
    expect(grants[0].earmark).toBe("Alex Aiken");
    expect(grants[0].amount).toBe(100813);
    expect(grants[0].date).toBe("2015-09-01");
  });

  it("parses multiple grants", () => {
    const sql = `insert into donations (donor, donee, donation_earmark,
        amount, donation_date,
        donation_date_precision, donation_date_basis, cause_area, url,
        donor_cause_area_url, notes, affected_countries, affected_states,
        affected_cities, affected_regions) values
    ('Future of Life Institute','Stanford University','Alex Aiken',100813.0,'2015-09-01','day','donation log','AI safety','https://futureoflife.org/AI/2015awardees#Aiken',NULL,'A project grant.',NULL,NULL,NULL,NULL)
    ,('Future of Life Institute','Machine Intelligence Research Institute','Benja Fallenstein',250000.0,'2015-09-01','day','donation log','AI safety','https://futureoflife.org/AI/2015awardees#Fallenstein',NULL,'A project grant.',NULL,NULL,NULL,NULL);`;

    const grants = parseFLISQLFile(sql);
    expect(grants.length).toBe(2);
    expect(grants[0].donee).toBe("Stanford University");
    expect(grants[1].donee).toBe("Machine Intelligence Research Institute");
    expect(grants[1].amount).toBe(250000);
  });

  it("returns empty array for non-FLI content", () => {
    const sql = "-- just a comment\nSELECT 1;";
    const grants = parseFLISQLFile(sql);
    expect(grants).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    const grants = parseFLISQLFile("");
    expect(grants).toEqual([]);
  });

  it("extracts URL field", () => {
    const sql = `insert into donations (donor, donee, donation_earmark,
        amount, donation_date,
        donation_date_precision, donation_date_basis, cause_area, url,
        donor_cause_area_url, notes, affected_countries, affected_states,
        affected_cities, affected_regions) values
    ('Future of Life Institute','University of Oxford','Nick Bostrom',1500000.0,'2015-09-01','day','donation log','AI safety','https://futureoflife.org/AI/2015awardees#Bostrom',NULL,'A center grant.',NULL,NULL,NULL,NULL);`;

    const grants = parseFLISQLFile(sql);
    expect(grants.length).toBe(1);
    expect(grants[0].url).toBe("https://futureoflife.org/AI/2015awardees#Bostrom");
    expect(grants[0].amount).toBe(1500000);
  });
});
