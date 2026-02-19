/**
 * Remark plugin that:
 * 1. Converts Starlight-style container directives (:::note, :::tip, etc.)
 *    into a "Callout" React component resolved from the MDX components map.
 * 2. Reverts unrecognized text/leaf directives back to plain text so that
 *    patterns like "3:1" aren't broken by remark-directive parsing ":1"
 *    as a text directive.
 *
 * Requires `remark-directive` to run before this plugin.
 */
import type { Plugin } from "unified";
import type { Root, Node, Parent } from "mdast";
import { visit, SKIP } from "unist-util-visit";

interface DirectiveNode {
  type: "containerDirective" | "leafDirective" | "textDirective";
  name: string;
  position?: Node["position"];
  attributes?: Record<string, string>;
  children: Node[];
  data?: Record<string, unknown>;
}

function isDirective(node: Node): node is DirectiveNode {
  return (
    node.type === "containerDirective" ||
    node.type === "leafDirective" ||
    node.type === "textDirective"
  );
}

const CALLOUT_TYPES = new Set(["note", "tip", "caution", "danger", "warning"]);

const CALLOUT_LABELS: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  caution: "Caution",
  danger: "Danger",
  warning: "Warning",
};

function extractText(nodes: Node[]): string {
  return nodes
    .map((n) => {
      if (n.type === "text") return (n as Node & { value: string }).value;
      if ("children" in n) return extractText((n as Parent).children as Node[]);
      return "";
    })
    .join("");
}

/**
 * Reconstruct the original markdown text for an unrecognized directive.
 * Text directives: `:name[label]{attrs}` → `:name` (or with label/attrs)
 * Leaf directives: `::name[label]{attrs}` → `::name`
 */
function directiveToText(node: DirectiveNode): string {
  const prefix = node.type === "textDirective" ? ":" : "::";
  const label = node.children?.length ? `[${extractText(node.children as Node[])}]` : "";

  const attrs = node.attributes;
  let attrStr = "";
  if (attrs && Object.keys(attrs).length > 0) {
    const parts = Object.entries(attrs).map(([k, v]) =>
      v === "" ? k : `${k}="${v}"`
    );
    attrStr = `{${parts.join(" ")}}`;
  }

  return `${prefix}${node.name}${label}${attrStr}`;
}

const remarkCallouts: Plugin<[], Root> = () => {
  return (tree: Root) => {
    visit(tree, (node: Node, index: number | undefined, parent: Parent | undefined) => {
      if (!isDirective(node)) return;

      // Handle container directives — convert known types to Callout component
      if (node.type === "containerDirective") {
        const name = (node as DirectiveNode).name.toLowerCase();
        if (!CALLOUT_TYPES.has(name)) return;

        let label = CALLOUT_LABELS[name] || "Note";
        const bodyChildren: Node[] = [];

        for (const child of (node as DirectiveNode).children) {
          const childAny = child as Node & { data?: Record<string, unknown>; children?: Node[] };
          if (
            child.type === "paragraph" &&
            childAny.data?.directiveLabel === true &&
            childAny.children
          ) {
            label = extractText(childAny.children) || label;
          } else {
            bodyChildren.push(child);
          }
        }

        node.data = node.data || {};
        const data = node.data as Record<string, unknown>;
        data.hName = "Callout";
        data.hProperties = {
          variant: name,
          title: label,
        };

        (node as DirectiveNode).children = bodyChildren;
        return;
      }

      // Revert unrecognized text/leaf directives back to plain text.
      // This prevents "3:1" from being broken (":1" parsed as textDirective).
      if (
        (node.type === "textDirective" || node.type === "leafDirective") &&
        parent &&
        typeof index === "number"
      ) {
        const textNode: Node & { value: string } = {
          type: "text",
          value: directiveToText(node as DirectiveNode),
        };
        (parent.children as Node[])[index] = textNode;
        return SKIP;
      }
    });
  };
};

export default remarkCallouts;
