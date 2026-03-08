import { Callout } from "@/components/wiki/Callout";

export function FactsPageContent() {
  return (
    <Callout variant="caution" title="Legacy Dashboard">
      <p>
        The old YAML facts pipeline has been retired. All structured entity data
        now lives in the{" "}
        <a href="/wiki/E827" className="text-primary hover:underline">
          KB (Knowledge Base)
        </a>{" "}
        system. This dashboard previously displayed facts from{" "}
        <code>data/facts/*.yaml</code>, which are no longer loaded into{" "}
        <code>database.json</code>.
      </p>
      <p className="mt-2">
        To view current structured data, use the{" "}
        <a href="/internal/entities" className="text-primary hover:underline">
          Entities dashboard
        </a>{" "}
        or the KB components (<code>&lt;KBFactTable&gt;</code>,{" "}
        <code>&lt;KBEntityFacts&gt;</code>) on individual entity pages.
      </p>
    </Callout>
  );
}
