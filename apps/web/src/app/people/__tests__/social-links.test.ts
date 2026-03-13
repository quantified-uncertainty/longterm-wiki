import { describe, it, expect } from "vitest";
import { collectSocialLinks } from "../[slug]/social-links";
import type { Fact } from "@longterm-wiki/kb";

function makeTextFact(value: string, source?: string): Fact {
  return {
    id: "f_test",
    subjectId: "test-entity",
    propertyId: "social-media",
    value: { type: "text", value },
    source,
  };
}

describe("collectSocialLinks", () => {
  it("extracts Twitter link from social-media KB fact", () => {
    const links = collectSocialLinks({
      socialMediaFact: makeTextFact("@DarioAmodei", "https://x.com/DarioAmodei"),
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      platform: "twitter",
      label: "@DarioAmodei",
      url: "https://x.com/DarioAmodei",
    });
  });

  it("extracts social links from entity sources", () => {
    const links = collectSocialLinks({
      entitySources: [
        { title: "Google Scholar", url: "https://scholar.google.com/citations?user=abc" },
        { title: "GitHub", url: "https://github.com/johndoe" },
        { title: "Wikipedia", url: "https://en.wikipedia.org/wiki/John_Doe" },
      ],
    });
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.platform)).toEqual(["scholar", "github", "wikipedia"]);
  });

  it("adds personal website when not an org site", () => {
    const links = collectSocialLinks({
      expertWebsite: "https://colah.github.io",
    });
    // colah.github.io is a github.com URL pattern but in subdomain form;
    // it doesn't match github.com/ so it's treated as a website
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      platform: "website",
      label: "colah.github.io",
    });
  });

  it("skips org websites like anthropic.com", () => {
    const links = collectSocialLinks({
      expertWebsite: "https://anthropic.com",
    });
    expect(links).toHaveLength(0);
  });

  it("deduplicates URLs", () => {
    const links = collectSocialLinks({
      socialMediaFact: makeTextFact("@test", "https://x.com/test"),
      entitySources: [
        { title: "Twitter", url: "https://x.com/test" },
      ],
    });
    expect(links).toHaveLength(1);
  });

  it("prefers expert website over entity website", () => {
    const links = collectSocialLinks({
      expertWebsite: "https://personal-site.com",
      entityWebsite: "https://other-site.com",
    });
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://personal-site.com");
  });

  it("returns empty array when no data available", () => {
    const links = collectSocialLinks({});
    expect(links).toHaveLength(0);
  });

  it("handles Twitter handle without @ prefix in KB fact", () => {
    const links = collectSocialLinks({
      socialMediaFact: makeTextFact("elonmusk", "https://x.com/elonmusk"),
    });
    expect(links[0].label).toBe("@elonmusk");
  });

  it("detects LinkedIn URLs from sources", () => {
    const links = collectSocialLinks({
      entitySources: [
        { title: "LinkedIn Profile", url: "https://linkedin.com/in/janedoe" },
      ],
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      platform: "linkedin",
      label: "LinkedIn",
    });
  });
});
