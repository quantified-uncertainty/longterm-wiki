import { describe, expect, it } from "vitest";
import katex from "katex";

describe("math rendering trust restrictions", () => {
  it("does not enable trusted links through inherited renderer options", () => {
    // GHSA-238p-pmpm-9mq7: an inherited trust flag must not enable unsafe URLs.
    const options = Object.create({ trust: true });
    const html = katex.renderToString(String.raw`\href{javascript:alert(1)}{click}`, options);

    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<a ");
  });

  it("still renders normal mathematical expressions", () => {
    const html = katex.renderToString(String.raw`\frac{1}{2} + x^2`, {
      throwOnError: true,
    });

    expect(html).toContain("katex-mathml");
    expect(html).toContain("<mfrac>");
    expect(html).toContain("<msup>");
    expect(html).not.toContain("katex-error");
  });
});
