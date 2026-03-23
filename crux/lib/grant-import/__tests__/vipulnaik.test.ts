import { describe, it, expect } from "vitest";
import { parseVNSQLFile } from "../sources/vipulnaik.ts";

describe("parseVNSQLFile", () => {
  it("parses standard column order (donor, donee, amount, donation_date)", () => {
    const sql = `insert into donations (donor, donee, amount, donation_date,
        donation_date_precision, donation_date_basis, cause_area, url,
        donor_cause_area_url, notes) values
    ('Arnold Ventures','Education Research Alliance',500000.0,'2017-05-15','day','donation log','Education','https://example.com',NULL,'Grant for research')
    ,('Arnold Ventures','Urban Institute',1000000.0,'2018-03-01','day','donation log','Criminal Justice',NULL,NULL,NULL);`;

    const grants = parseVNSQLFile(sql);
    expect(grants).toHaveLength(2);
    expect(grants[0].donor).toBe("Arnold Ventures");
    expect(grants[0].donee).toBe("Education Research Alliance");
    expect(grants[0].amount).toBe(500000);
    expect(grants[0].date).toBe("2017-05-15");
    expect(grants[0].causeArea).toBe("Education");
    expect(grants[0].url).toBe("https://example.com");
    expect(grants[0].notes).toBe("Grant for research");
    expect(grants[1].amount).toBe(1000000);
    expect(grants[1].causeArea).toBe("Criminal Justice");
    expect(grants[1].url).toBeNull();
  });

  it("parses column order with donation_earmark", () => {
    const sql = `insert into donations (donor, donee, donation_earmark, amount, donation_date, donation_date_precision, donation_date_basis, cause_area, url, donor_cause_area_url, notes) values
    ('Knut and Alice Wallenberg Foundation','Uppsala University','Bengt Westermark',1939253.45,'2011-01-01','year','donation log',NULL,'https://kaw.wallenberg.org',NULL,'Project: New markers');`;

    const grants = parseVNSQLFile(sql);
    expect(grants).toHaveLength(1);
    expect(grants[0].earmark).toBe("Bengt Westermark");
    expect(grants[0].amount).toBeCloseTo(1939253.45, 0);
    expect(grants[0].date).toBe("2011-01-01");
  });

  it("handles SQL-escaped quotes in strings", () => {
    const sql = `insert into donations (donor, donee, amount, donation_date, donation_date_precision, donation_date_basis, cause_area, url, donor_cause_area_url, notes) values
    ('Test Donor','O''Brien Foundation',100000.0,'2020-01-01','day','donation log','Test',NULL,NULL,'They''re great');`;

    const grants = parseVNSQLFile(sql);
    expect(grants).toHaveLength(1);
    expect(grants[0].donee).toBe("O'Brien Foundation");
    expect(grants[0].notes).toBe("They're great");
  });

  it("handles multiple INSERT blocks in one file", () => {
    const sql = `insert into donations(donor,donee,amount,donation_date,donation_date_precision,donation_date_basis,cause_area,url,notes) values
  ('Vitalik Buterin','MIRI',802136.0,'2018-01-17','year','donee contributor list','AI safety','https://example.com',NULL);

insert into donations(donor, donee, amount, donation_date, donation_date_precision, donation_date_basis, cause_area, url, notes) values
  ('Vitalik Buterin','SENS Research Foundation',2400000.0,'2017-12-14','day','transaction','Life sciences/anti-aging','https://example.com',NULL);`;

    const grants = parseVNSQLFile(sql);
    expect(grants).toHaveLength(2);
    expect(grants[0].donee).toBe("MIRI");
    expect(grants[1].donee).toBe("SENS Research Foundation");
  });

  it("skips rows with zero or negative amounts", () => {
    const sql = `insert into donations (donor, donee, amount, donation_date, donation_date_precision, donation_date_basis, cause_area, url, donor_cause_area_url, notes) values
    ('Test','Org A',0.0,'2020-01-01','day','log',NULL,NULL,NULL,NULL)
    ,('Test','Org B',100.0,'2020-01-01','day','log',NULL,NULL,NULL,NULL);`;

    const grants = parseVNSQLFile(sql);
    expect(grants).toHaveLength(1);
    expect(grants[0].donee).toBe("Org B");
  });

  it("returns empty for non-INSERT content", () => {
    expect(parseVNSQLFile("SELECT * FROM donations;")).toHaveLength(0);
  });
});
