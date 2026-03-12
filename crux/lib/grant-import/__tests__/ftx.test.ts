import { describe, it, expect } from "vitest";
import { parseFTXSQLFile } from "../sources/ftx-future-fund.ts";

describe("parseFTXSQLFile", () => {
  it("extracts basic grant from SQL INSERT", () => {
    const sql = `insert into donations(donor,donee,amount,donation_date) values
('FTX Future Fund','Redwood Research',5000000,'2022-05-01','month','donation log',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);`;

    const grants = parseFTXSQLFile(sql, "open-call");
    expect(grants.length).toBeGreaterThanOrEqual(1);
    expect(grants[0].donee).toBe("Redwood Research");
    expect(grants[0].amount).toBe(5000000);
    expect(grants[0].date).toBe("2022-05-01");
    expect(grants[0].grantType).toBe("open-call");
  });

  it("handles escaped single quotes in donee name", () => {
    const sql = `insert into donations(donor,donee,amount,donation_date) values
('FTX Future Fund','Donee''s Project',100000,'2022-06-01','month','donation log',NULL);`;

    const grants = parseFTXSQLFile(sql, "regrant");
    expect(grants.length).toBeGreaterThanOrEqual(1);
    expect(grants[0].donee).toBe("Donee's Project");
    expect(grants[0].grantType).toBe("regrant");
  });

  it("parses multiple grants from one file", () => {
    const sql = `insert into donations(donor,donee,amount,donation_date) values
('FTX Future Fund','Org A',100000,'2022-01-01','month','donation log',NULL),
('FTX Future Fund','Org B',200000,'2022-02-01','month','donation log',NULL);`;

    const grants = parseFTXSQLFile(sql, "staff-led");
    expect(grants.length).toBe(2);
    expect(grants[0].donee).toBe("Org A");
    expect(grants[1].donee).toBe("Org B");
  });

  it("returns empty array for content with no matching rows", () => {
    const sql = "-- just a comment\nSELECT 1;";
    const grants = parseFTXSQLFile(sql, "open-call");
    expect(grants).toEqual([]);
  });
});
