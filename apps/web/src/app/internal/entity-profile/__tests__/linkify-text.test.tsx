import { describe, it, expect } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { linkifyText } from "../linkify-text";

function flatten(node: ReactNode): { text: string; hrefs: string[] } {
  const hrefs: string[] = [];
  let text = "";
  const visit = (n: ReactNode) => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      text += String(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (isValidElement(n)) {
      const el = n as ReactElement<{ href?: string; children?: ReactNode }>;
      if (el.props.href) hrefs.push(el.props.href);
      text += "[link]";
      if (el.props.children) visit(el.props.children);
      text += "[/link]";
    }
  };
  visit(node);
  return { text, hrefs };
}

describe("linkifyText", () => {
  it("returns the input string unchanged when there are no URLs", () => {
    expect(linkifyText("just some text")).toBe("just some text");
    expect(linkifyText("")).toBe("");
  });

  it("linkifies a URL embedded in prose and keeps the digits out of innerText", () => {
    const input =
      "[Navigating Transformative AI] https://web.archive.org/web/20240601000000/https://openphilanthropy.org/grants/openai-general-support/";
    const { text, hrefs } = flatten(linkifyText(input));
    // The 14-digit timestamp must not leak as visible text.
    expect(text).not.toMatch(/20240601000000/);
    // The URL text is replaced by its hostname.
    expect(text).toContain("web.archive.org");
    // The href still contains the original URL.
    expect(hrefs[0]).toContain("20240601000000");
  });

  it("links multiple URLs in one string", () => {
    const { hrefs } = flatten(
      linkifyText("see https://example.com/a and https://foo.bar/b for details"),
    );
    expect(hrefs).toHaveLength(2);
    expect(hrefs[0]).toBe("https://example.com/a");
    expect(hrefs[1]).toBe("https://foo.bar/b");
  });

  it("trims trailing sentence punctuation from the URL", () => {
    const { hrefs } = flatten(linkifyText("go to https://example.com/page."));
    expect(hrefs[0]).toBe("https://example.com/page");
  });

  it("leaves digits in non-URL text alone", () => {
    const { text } = flatten(linkifyText("Internal Revenue: 1700000000"));
    expect(text).toBe("Internal Revenue: 1700000000");
  });
});
