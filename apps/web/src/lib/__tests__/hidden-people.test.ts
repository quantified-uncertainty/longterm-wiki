import { describe, expect, it } from "vitest";
import { isHiddenPerson, scrubHiddenPeople } from "../hidden-people";

describe("isHiddenPerson", () => {
  it("matches hidden slugs", () => {
    expect(isHiddenPerson("olivia-jimenez")).toBe(true);
    expect(isHiddenPerson("ben-hoskin")).toBe(true);
    expect(isHiddenPerson("5hsN7xhTbY")).toBe(true);
  });

  it("matches hidden names regardless of case, punctuation and accents", () => {
    expect(isHiddenPerson("Olivia Jimenez")).toBe(true);
    expect(isHiddenPerson("olivia g jimenez")).toBe(true);
    expect(isHiddenPerson("Olivia Jiménez")).toBe(true);
    expect(isHiddenPerson("new:Olivia G. Jimenez")).toBe(true);
    expect(isHiddenPerson("Benjamin Hoskin")).toBe(true);
  });

  it("checks every candidate and ignores empty ones", () => {
    expect(isHiddenPerson(null, undefined, "sid_abc", "Olivia Jimenez")).toBe(true);
  });

  it("does not match other people", () => {
    expect(isHiddenPerson("jason-green-lowe", "Jason Green-Lowe")).toBe(false);
    expect(isHiddenPerson("Olivia Alperstein")).toBe(false);
    expect(isHiddenPerson()).toBe(false);
  });

  it("returns null for a hidden person's own record", () => {
    expect(scrubHiddenPeople({ id: "5hsN7xhTbY", name: "Ben Hoskin" })).toBeNull();
  });
});

describe("scrubHiddenPeople", () => {
  it("filters hidden people out of result arrays", () => {
    const data = {
      items: [
        { id: "5hsN7xhTbY", slug: "ben-hoskin", name: "Ben Hoskin" },
        { id: "MaXsOeYAdn", slug: "aza-raskin", name: "Aza Raskin" },
      ],
    };
    expect(scrubHiddenPeople(data)).toEqual({
      items: [{ id: "MaXsOeYAdn", slug: "aza-raskin", name: "Aza Raskin" }],
    });
  });

  it("drops rows that reference a hidden person only by id, and lookup-map entries", () => {
    const profile = {
      title: "Alignment Research Center",
      personnel: [
        { personId: "5hsN7xhTbY", role: "Board member" },
        { personId: "sid_KKCwTYU4Zw", role: "President" },
      ],
      entities: {
        "5hsN7xhTbY": { title: "Ben Hoskin", slug: "ben-hoskin", entityType: "person" },
        sid_KKCwTYU4Zw: { title: "Jacob Hilton", slug: "jacob-hilton", entityType: "person" },
      },
    };
    expect(scrubHiddenPeople(profile)).toEqual({
      title: "Alignment Research Center",
      personnel: [{ personId: "sid_KKCwTYU4Zw", role: "President" }],
      entities: {
        sid_KKCwTYU4Zw: { title: "Jacob Hilton", slug: "jacob-hilton", entityType: "person" },
      },
    });
  });

  it("leaves primitives and unrelated data untouched", () => {
    expect(scrubHiddenPeople("Ben Hoskin")).toBe("Ben Hoskin");
    expect(scrubHiddenPeople({ total: 3, q: "hoskin" })).toEqual({ total: 3, q: "hoskin" });
  });
});
