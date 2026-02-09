import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkDirective from "remark-directive";
import remarkStringify from "remark-stringify";
import remarkCallouts from "../remark-callouts";

async function processMarkdown(md: string) {
  const result = await unified()
    .use(remarkParse)
    .use(remarkDirective)
    .use(remarkCallouts)
    .use(remarkStringify)
    .process(md);
  return result;
}

function getTree(md: string) {
  return unified()
    .use(remarkParse)
    .use(remarkDirective)
    .use(remarkCallouts)
    .runSync(unified().use(remarkParse).use(remarkDirective).parse(md));
}

describe("remarkCallouts", () => {
  it("converts :::note to Callout component", () => {
    const tree = getTree(":::note\nSome content\n:::");
    const node = tree.children[0] as any;
    expect(node.data?.hName).toBe("Callout");
    expect(node.data?.hProperties?.variant).toBe("note");
    expect(node.data?.hProperties?.title).toBe("Note");
  });

  it("converts all callout types", () => {
    for (const type of ["note", "tip", "caution", "danger", "warning"]) {
      const tree = getTree(`:::${type}\nContent\n:::`);
      const node = tree.children[0] as any;
      expect(node.data?.hName).toBe("Callout");
      expect(node.data?.hProperties?.variant).toBe(type);
    }
  });

  it("leaves unknown container directives untouched", () => {
    const tree = getTree(":::custom\nContent\n:::");
    const node = tree.children[0] as any;
    expect(node.data?.hName).toBeUndefined();
  });

  it("reverts text directives to plain text", async () => {
    // "3:1" gets parsed as "3" + textDirective ":1"
    const result = await processMarkdown("ratio 3:1 is common");
    const output = String(result);
    // The ":1" should be preserved as text, not eaten as a directive
    expect(output).toContain(":1");
  });

  it("reverts leaf directives to plain text", async () => {
    const result = await processMarkdown("::unknownDirective");
    const output = String(result);
    expect(output).toContain("::unknownDirective");
  });
});
