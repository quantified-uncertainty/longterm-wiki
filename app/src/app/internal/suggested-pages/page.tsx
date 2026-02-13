import type { Metadata } from "next";
import { SuggestedPagesTable, type SuggestedPage } from "./suggested-pages-table";

export const metadata: Metadata = {
  title: "Suggested Pages | Longterm Wiki Internal",
  description:
    "Prioritized list of pages the wiki should add, based on gap analysis.",
};

const suggestions: SuggestedPage[] = [
  {
    rank: 1,
    title: "DeepSeek",
    type: "organization",
    tier: "Critical",
    reason:
      "Leading Chinese frontier lab (R1, V3) — changed compute-efficiency assumptions globally. No entity exists.",
    relatedPages: [],
    command: 'pnpm crux content create "DeepSeek" --tier=standard',
  },
  {
    rank: 2,
    title: "Test-Time Compute & Reasoning Models",
    type: "capability",
    tier: "Critical",
    reason:
      "The o1/o3/R1 inference-scaling paradigm is a fundamental shift. Changes safety assumptions about evaluation, containment, and capability forecasting.",
    relatedPages: [],
    command:
      'pnpm crux content create "Test-Time Compute and Reasoning Models" --tier=standard',
  },
  {
    rank: 3,
    title: "Frontier Model Transparency & Safety Reporting",
    type: "response",
    tier: "Critical",
    reason:
      "Every major lab publishes safety evals, but no page compares what they report or tracks compliance.",
    relatedPages: [
      { id: "responsible-scaling-policies", title: "Responsible Scaling Policies" },
    ],
    command:
      'pnpm crux content create "Frontier Model Transparency and Safety Reporting" --tier=standard',
  },
  {
    rank: 4,
    title: "Hallucination",
    type: "risk",
    tier: "Critical",
    reason:
      "Referenced in 33+ existing pages but has no dedicated page. Most user-visible AI failure mode.",
    relatedPages: [],
    command: 'pnpm crux content create "Hallucination" --tier=standard',
  },
  {
    rank: 5,
    title: "Prompt Injection & Jailbreaking",
    type: "risk",
    tier: "Critical",
    reason:
      "Primary attack vector against deployed LLMs. Discussed across red-teaming pages but no dedicated treatment.",
    relatedPages: [
      { id: "adversarial-robustness", title: "Adversarial Robustness" },
    ],
    command:
      'pnpm crux content create "Prompt Injection and Jailbreaking" --tier=standard',
  },
  {
    rank: 6,
    title: "Mistral AI",
    type: "organization",
    tier: "High",
    reason:
      "Leading European frontier lab. Important for EU AI Act context and non-US AI development.",
    relatedPages: [],
    command: 'pnpm crux content create "Mistral AI" --tier=standard',
  },
  {
    rank: 7,
    title: "AI Incidents Compendium (2024–2026)",
    type: "incidents",
    tier: "High",
    reason:
      "Only 2 incident pages exist. Documented failures are essential evidence for safety arguments.",
    relatedPages: [],
    command:
      'pnpm crux content create "AI Incidents Compendium" --tier=standard',
  },
  {
    rank: 8,
    title: "Data Poisoning",
    type: "risk",
    tier: "High",
    reason:
      "Supply-chain attack on training data. Mentioned in 13 pages but no dedicated analysis.",
    relatedPages: [
      { id: "adversarial-robustness", title: "Adversarial Robustness" },
    ],
    command: 'pnpm crux content create "Data Poisoning" --tier=standard',
  },
  {
    rank: 9,
    title: "Multimodal AI & Vision Models",
    type: "capability",
    tier: "High",
    reason:
      "GPT-4V, Gemini, multimodal frontier has distinct safety challenges. Referenced in 38 pages.",
    relatedPages: [],
    command:
      'pnpm crux content create "Multimodal AI and Vision Models" --tier=standard',
  },
  {
    rank: 10,
    title: "AI Liability & Legal Frameworks",
    type: "response",
    tier: "High",
    reason:
      '"Who pays when AI causes harm?" is a foundational governance question.',
    relatedPages: [
      { id: "legal-evidence-crisis", title: "Legal Evidence Crisis" },
    ],
    command:
      'pnpm crux content create "AI Liability and Legal Frameworks" --tier=standard',
  },
  {
    rank: 11,
    title: "Foundation Model Commoditization",
    type: "model",
    tier: "Important",
    reason:
      "Pricing collapse changes lab safety incentives.",
    relatedPages: [
      { id: "ai-revenue-sources", title: "AI Revenue Sources" },
      { id: "winner-take-all-concentration", title: "Winner-Take-All Concentration" },
    ],
    command:
      'pnpm crux content create "Foundation Model Commoditization" --tier=standard',
  },
  {
    rank: 12,
    title: "Speculative Decoding & Inference Optimization",
    type: "intelligence-paradigm",
    tier: "Important",
    reason:
      "How models are deployed affects safety properties. Virtually no coverage.",
    relatedPages: [],
    command:
      'pnpm crux content create "Speculative Decoding and Inference Optimization" --tier=standard',
  },
  {
    rank: 13,
    title: "Chinese AI Ecosystem",
    type: "response",
    tier: "Important",
    reason:
      "Baidu, Alibaba, Tencent, ByteDance — safety practices and governance differ significantly from Western labs.",
    relatedPages: [
      { id: "geopolitics", title: "Geopolitics" },
    ],
    command:
      'pnpm crux content create "Chinese AI Ecosystem" --tier=standard',
  },
  {
    rank: 14,
    title: "Model Merging & Weight Manipulation",
    type: "risk",
    tier: "Important",
    reason:
      "Widely used in open-source to combine capabilities, potentially bypassing safety fine-tuning.",
    relatedPages: [
      { id: "open-source", title: "Open Source" },
    ],
    command:
      'pnpm crux content create "Model Merging and Weight Manipulation" --tier=standard',
  },
  {
    rank: 15,
    title: "In-Context Learning & Few-Shot",
    type: "capability",
    tier: "Important",
    reason:
      "Fundamental to LLM capability. Safety implications for capability elicitation and jailbreaking.",
    relatedPages: [],
    command:
      'pnpm crux content create "In-Context Learning and Few-Shot Prompting" --tier=standard',
  },
  {
    rank: 16,
    title: "Reward Modeling",
    type: "response",
    tier: "Important",
    reason:
      "Reward hacking exists as a risk page, but the positive side (how to specify rewards) needs treatment.",
    relatedPages: [
      { id: "reward-hacking", title: "Reward Hacking" },
    ],
    command:
      'pnpm crux content create "Reward Modeling" --tier=standard',
  },
  {
    rank: 17,
    title: "AI-Enabled Scientific Fraud",
    type: "risk",
    tier: "Important",
    reason:
      "Paper mills, fabricated data, fake peer reviews. Emerging risk with no coverage.",
    relatedPages: [
      { id: "scientific-corruption", title: "Scientific Corruption" },
    ],
    command:
      'pnpm crux content create "AI-Enabled Scientific Fraud" --tier=standard',
  },
  {
    rank: 18,
    title: "Post-Deployment Monitoring & Safety Ops",
    type: "response",
    tier: "Important",
    reason:
      "Most safety work focuses on pre-deployment. Runtime monitoring needs dedicated coverage.",
    relatedPages: [],
    command:
      'pnpm crux content create "Post-Deployment Monitoring" --tier=standard',
  },
  {
    rank: 19,
    title: "Compute Governance Implementation Tracking",
    type: "metric",
    tier: "Important",
    reason:
      "Compute governance pages exist but don't track whether thresholds are actually enforced.",
    relatedPages: [
      { id: "compute-governance", title: "Compute Governance" },
    ],
    command:
      'pnpm crux content create "Compute Governance Implementation Tracking" --tier=standard',
  },
  {
    rank: 20,
    title: "Adversarial Robustness (Expand Stub)",
    type: "response",
    tier: "Important",
    reason:
      'Stub page exists — referenced by 122 other pages but marked "Content needed."',
    relatedPages: [
      { id: "adversarial-robustness", title: "Adversarial Robustness" },
    ],
    command:
      "pnpm crux content improve adversarial-robustness --tier=standard --apply",
  },
];

export default function SuggestedPagesPage() {
  const criticalCount = suggestions.filter((s) => s.tier === "Critical").length;
  const highCount = suggestions.filter((s) => s.tier === "High").length;
  const importantCount = suggestions.filter((s) => s.tier === "Important").length;

  return (
    <article className="prose max-w-none">
      <h1>Suggested Pages</h1>
      <p className="text-muted-foreground">
        Pages the wiki should add, prioritized by importance to AI safety
        coverage. Sourced from the{" "}
        <a href="/internal/gap-analysis-2026-02">Feb 2026 gap analysis</a>.{" "}
        <span className="font-medium text-red-500">{criticalCount} critical</span>,{" "}
        <span className="font-medium text-amber-500">{highCount} high</span>,{" "}
        <span className="font-medium text-blue-500">{importantCount} important</span>.
      </p>
      <SuggestedPagesTable data={suggestions} />
    </article>
  );
}
