// Deployment/Safety Architectures Table Data

export type SafetyOutlook = "favorable" | "mixed" | "challenging" | "unknown";
export type Category = "basic" | "structured" | "oversight";

export interface Source {
  title: string;
  url?: string;
  year?: string;
}

export interface Architecture {
  id: string;
  category: Category;
  name: string;
  description: string;
  adoption: string;
  adoptionNote: string;
  timeline: string;
  safetyOutlook: {
    rating: SafetyOutlook;
    score?: number;
    summary: string;
  };
  agencyLevel: { level: string; note: string };
  decomposition: { level: string; note: string };
  oversight: { level: string; note: string };
  whitebox: { level: string; note: string };
  modularity: { level: string; note: string };
  verifiable: { level: string; note: string };
  sources: Source[];
  safetyPros: string[];
  safetyCons: string[];
}

export const CATEGORY_ORDER: Category[] = ["basic", "structured", "oversight"];

export const architectures: Architecture[] = [
  // === BASIC PATTERNS ===
  {
    id: "monolithic-minimal",
    category: "basic",
    name: "Monolithic / Minimal Scaffolding",
    description:
      "Single model with direct API access. No persistent memory, minimal tools. Like ChatGPT web or basic Claude usage.",
    adoption: "DECLINING",
    adoptionNote: "Legacy pattern; scaffolding adds clear value",
    timeline: "Now (legacy)",
    safetyOutlook: {
      rating: "mixed",
      score: 5,
      summary: "Simple threat model but limited interpretability",
    },
    agencyLevel: { level: "HIGH", note: "Single model makes all decisions" },
    decomposition: {
      level: "NONE",
      note: "Single forward pass or CoT in one context",
    },
    oversight: { level: "MINIMAL", note: "Human sees inputs/outputs only" },
    whitebox: { level: "LOW", note: "Model internals opaque" },
    modularity: { level: "LOW", note: "Monolithic model" },
    verifiable: { level: "LOW", note: "No formal guarantees" },
    sources: [
      {
        title: "InstructGPT",
        url: "https://arxiv.org/abs/2203.02155",
        year: "2022",
      },
    ],
    safetyPros: ["Simple to analyze", "Limited action space"],
    safetyCons: ["Model internals opaque", "Relies entirely on training"],
  },
  {
    id: "light-scaffolding",
    category: "basic",
    name: "Light Scaffolding",
    description:
      "Model + basic tool use + simple chains. RAG, function calling, single-agent loops. Like GPT with plugins.",
    adoption: "HIGH",
    adoptionNote: "Current mainstream; most deployed systems",
    timeline: "Now - 2027",
    safetyOutlook: {
      rating: "mixed",
      score: 5,
      summary:
        "Tool use adds capability and risk; scaffold provides some inspection",
    },
    agencyLevel: {
      level: "MEDIUM-HIGH",
      note: "Model retains most decision-making",
    },
    decomposition: { level: "BASIC", note: "Simple tool calls, RAG retrieval" },
    oversight: {
      level: "HUMAN (limited)",
      note: "Tool permissions controllable",
    },
    whitebox: { level: "MEDIUM", note: "Scaffold code readable; model opaque" },
    modularity: { level: "MEDIUM", note: "Clear tool boundaries" },
    verifiable: { level: "PARTIAL", note: "Scaffold code can be verified" },
    sources: [
      {
        title: "Toolformer",
        url: "https://arxiv.org/abs/2302.04761",
        year: "2023",
      },
      { title: "RAG", url: "https://arxiv.org/abs/2005.11401", year: "2020" },
    ],
    safetyPros: ["Scaffold logic inspectable", "Tool permissions controllable"],
    safetyCons: [
      "Tool use enables real-world harm",
      "Model decisions still opaque",
    ],
  },
  {
    id: "tool-oracle",
    category: "basic",
    name: "Tool AI / Oracle",
    description:
      "Bostrom's taxonomy. Tool: narrow software-like, no persistent goals. Oracle: questions only. Agency structurally constrained.",
    adoption: "MEDIUM",
    adoptionNote: "Used for specialized applications",
    timeline: "Now - ongoing",
    safetyOutlook: {
      rating: "favorable",
      score: 7,
      summary: "Safety through limitation; capability traded for safety",
    },
    agencyLevel: { level: "MINIMAL", note: "No persistent goals, narrow scope" },
    decomposition: {
      level: "N/A",
      note: "Scope-restricted instead of decomposed",
    },
    oversight: { level: "SCOPE CONSTRAINT", note: "Safety through limitation" },
    whitebox: {
      level: "LOW-MEDIUM",
      note: "Limited scope means less to inspect",
    },
    modularity: { level: "LOW", note: "Single-purpose by design" },
    verifiable: { level: "PARTIAL", note: "Behavior bounded by constraint" },
    sources: [
      {
        title: "Superintelligence (Bostrom)",
        url: "https://nickbostrom.com/papers/oracle.pdf",
        year: "2014",
      },
    ],
    safetyPros: [
      "Minimal agency",
      "Clear boundaries",
      "Human decides actions",
    ],
    safetyCons: ["Limited capability", "May develop emergent agency"],
  },
  // === STRUCTURED SAFETY ARCHITECTURES ===
  {
    id: "cais-services",
    category: "structured",
    name: "CAIS / Service-Based",
    description:
      "Comprehensive AI Services (Drexler). Many task-specific services rather than unified agents. Agency optional, not default.",
    adoption: "LOW-MEDIUM",
    adoptionNote: "15-25% chance becomes dominant paradigm",
    timeline: "2026-2032",
    safetyOutlook: {
      rating: "favorable",
      score: 7,
      summary: "Avoids unified agency; bounded goals; ongoing human direction",
    },
    agencyLevel: {
      level: "LOW",
      note: "Services have bounded, task-specific goals",
    },
    decomposition: {
      level: "SERVICE-LEVEL",
      note: "System = many specialized services",
    },
    oversight: {
      level: "HUMAN",
      note: "Services informed by models of human approval",
    },
    whitebox: {
      level: "PARTIAL",
      note: "Service boundaries visible; internals may be opaque",
    },
    modularity: { level: "HIGH", note: "Explicit service architecture" },
    verifiable: {
      level: "PARTIAL",
      note: "Inter-service protocols can be verified",
    },
    sources: [
      {
        title: "Reframing Superintelligence",
        url: "https://www.fhi.ox.ac.uk/reframing/",
        year: "2019",
      },
      {
        title: "CAIS - EA Forum",
        url: "https://forum.effectivealtruism.org/topics/comprehensive-ai-services",
      },
    ],
    safetyPros: [
      "No unified agency",
      "Bounded goals",
      "Incremental development",
    ],
    safetyCons: [
      "Coordination complexity",
      "Agency creep possible",
      "Foundation model gap",
    ],
  },
  {
    id: "ai-control",
    category: "structured",
    name: "AI Control / Hierarchical (T/U)",
    description:
      "Redwood Research. Trusted model T monitors untrusted model U. Designed to work even if U intentionally subverts. 92% safety / 94% usefulness.",
    adoption: "MEDIUM",
    adoptionNote: "20-35% chance; active research area",
    timeline: "2025-2030",
    safetyOutlook: {
      rating: "favorable",
      score: 7,
      summary: "Maintains safety despite intentional subversion attempts",
    },
    agencyLevel: { level: "MEDIUM", note: "U has capability but T constrains" },
    decomposition: {
      level: "T/U SPLIT",
      note: "Binary: trusted monitors untrusted",
    },
    oversight: {
      level: "AI MONITORS AI",
      note: "Scalable without linear human effort",
    },
    whitebox: {
      level: "PARTIAL",
      note: "Protocol logic visible; U internals constrained",
    },
    modularity: { level: "MEDIUM", note: "Clear T/U separation" },
    verifiable: {
      level: "PARTIAL",
      note: "Protocol effectiveness empirically tested",
    },
    sources: [
      {
        title: "AI Control Paper",
        url: "https://arxiv.org/abs/2312.06942",
        year: "2024",
      },
      {
        title: "Redwood Research",
        url: "https://www.redwoodresearch.org/research/ai-control",
      },
    ],
    safetyPros: [
      "Works despite subversion",
      "Scalable oversight",
      "Empirically validated",
    ],
    safetyCons: [
      "Capability gap may close",
      "Collusion risk",
      "T must be trustworthy",
    ],
  },
  {
    id: "factored-cognition",
    category: "structured",
    name: "Factored Cognition",
    description:
      "Decompose tasks into isolated child tasks solved independently. Factor(T,U): 41% to 63% safety improvement. Simpler contexts for monitors.",
    adoption: "MEDIUM",
    adoptionNote: "15-30% chance; complements AI Control",
    timeline: "2025-2030",
    safetyOutlook: {
      rating: "favorable",
      score: 7,
      summary: "Decomposition creates easier tasks and clearer contexts",
    },
    agencyLevel: {
      level: "LOW-MEDIUM",
      note: "Components have limited context",
    },
    decomposition: {
      level: "TASK-LEVEL",
      note: "Complex tasks into isolated children",
    },
    oversight: {
      level: "CONTEXT ISOLATION",
      note: "Attacks more obvious on simpler tasks",
    },
    whitebox: {
      level: "PARTIAL-HIGH",
      note: "Decomposition structure visible",
    },
    modularity: { level: "HIGH", note: "Explicit task boundaries" },
    verifiable: { level: "PARTIAL", note: "Can audit composition of results" },
    sources: [
      {
        title: "Factor(T,U)",
        url: "https://arxiv.org/abs/2512.02157",
        year: "2024",
      },
      {
        title: "Factored Cognition - LessWrong",
        url: "https://www.lesswrong.com/posts/tgLmDjKRXaX3dokrC/factored-cognition-strengthens-monitoring-and-thwarts",
      },
    ],
    safetyPros: [
      "Simpler contexts",
      "Attacks more obvious",
      "Compositional safety",
    ],
    safetyCons: ["Decomposition limits", "Information loss", "Usefulness cost"],
  },
  {
    id: "open-agency",
    category: "structured",
    name: "Open Agency Architecture",
    description:
      "Drexler/davidad. Separate goal-setting, planning, evaluation, execution. Plans externalized and interpretable. Foundation for Provably Safe AI.",
    adoption: "LOW",
    adoptionNote: "5-15% chance; ambitious long-term agenda",
    timeline: "2027-2035",
    safetyOutlook: {
      rating: "favorable",
      score: 8,
      summary: "Designed for formal analysis; externalized plans",
    },
    agencyLevel: {
      level: "MEDIUM (bounded)",
      note: "Bounded tasks with time/budget constraints",
    },
    decomposition: {
      level: "ROLE SEPARATION",
      note: "Separate goal/plan/evaluate/execute",
    },
    oversight: {
      level: "EXTERNALIZED PLANS",
      note: "Plans interpretable, not opaque",
    },
    whitebox: { level: "HIGH", note: "Designed for formal analysis" },
    modularity: { level: "HIGH", note: "Clear role separation" },
    verifiable: {
      level: "PARTIAL-HIGH",
      note: "Compositional verification possible",
    },
    sources: [
      {
        title: "Open Agency Model",
        url: "https://www.lesswrong.com/posts/5hApNw5f7uG8RXxGS/the-open-agency-model",
      },
      {
        title: "ARIA Safeguarded AI",
        url: "https://www.aria.org.uk/programme/safeguarded-ai/",
      },
    ],
    safetyPros: ["Externalized plans", "Formal analysis", "Role separation"],
    safetyCons: [
      "May not scale to TAI",
      "Specification difficulty",
      "Capability tax",
    ],
  },
  {
    id: "safety-first-cognitive",
    category: "structured",
    name: "Safety-First Cognitive Architectures",
    description:
      "Federated architectures with transparent inter-component communication. Separate planning, execution, memory. Interpretability by design.",
    adoption: "LOW-MEDIUM",
    adoptionNote: "Emerging field; underdeveloped",
    timeline: "2025-2030",
    safetyOutlook: {
      rating: "favorable",
      score: 7,
      summary: "Intelligence from separate, non-agentic systems",
    },
    agencyLevel: {
      level: "MEDIUM (federated)",
      note: "No single unified agent",
    },
    decomposition: {
      level: "COGNITIVE ROLES",
      note: "Separate planning/execution/memory",
    },
    oversight: {
      level: "TRANSPARENT COMMS",
      note: "Human-readable, rate-controlled",
    },
    whitebox: {
      level: "HIGH",
      note: "Communication channels visible by design",
    },
    modularity: { level: "HIGH", note: "Explicit component architecture" },
    verifiable: {
      level: "PARTIAL",
      note: "Can verify communication protocols",
    },
    sources: [
      {
        title: "Safety-First Agents",
        url: "https://www.lesswrong.com/posts/caeXurgTwKDpSG4Nh/safety-first-agents-architectures-are-a-promising-path-to",
      },
    ],
    safetyPros: [
      "Transparent by design",
      "Federated = no unified agent",
      "Rate-controlled",
    ],
    safetyCons: ["Field underdeveloped", "May not compete on capability"],
  },
  // === OVERSIGHT MECHANISMS ===
  {
    id: "process-supervision",
    category: "oversight",
    name: "Process Supervision",
    description:
      "OpenAI. Reward each reasoning step, not just outcome. 78.2% vs 72.4% on MATH. Deployed in o1 models. Detects bad reasoning.",
    adoption: "HIGH",
    adoptionNote: "Already deployed in production (o1)",
    timeline: "Now - expanding",
    safetyOutlook: {
      rating: "favorable",
      score: 7,
      summary: "Step-by-step verification catches bad reasoning",
    },
    agencyLevel: {
      level: "VARIABLE",
      note: "Doesn't constrain agency directly",
    },
    decomposition: {
      level: "STEP-BY-STEP",
      note: "Reasoning into verifiable steps",
    },
    oversight: {
      level: "STEP VERIFICATION",
      note: "Each step evaluated for correctness",
    },
    whitebox: { level: "MEDIUM-HIGH", note: "Reasoning steps visible" },
    modularity: { level: "MEDIUM", note: "Step boundaries clear" },
    verifiable: {
      level: "PARTIAL",
      note: "Steps can be verified individually",
    },
    sources: [
      {
        title: "Let's Verify Step by Step",
        url: "https://arxiv.org/abs/2305.20050",
        year: "2023",
      },
      {
        title: "PRM800K",
        url: "https://github.com/openai/prm800k",
        year: "2023",
      },
    ],
    safetyPros: [
      "Catches bad reasoning",
      "Deployed at scale",
      "Strong empirical results",
    ],
    safetyCons: [
      "May not transfer to all domains",
      "Process-outcome gap",
      "Alien reasoning risk",
    ],
  },
  {
    id: "debate-adversarial",
    category: "oversight",
    name: "Debate / Adversarial Oversight",
    description:
      "Irving et al. Two AIs argue opposing positions, human judges. Truth should win via adversarial scrutiny. 60-80% on factual Qs.",
    adoption: "LOW-MEDIUM",
    adoptionNote: "Research stage; promising but challenges",
    timeline: "2026-2032",
    safetyOutlook: {
      rating: "mixed",
      score: 6,
      summary: "Promising but vulnerable to sophisticated deception",
    },
    agencyLevel: {
      level: "MEDIUM",
      note: "Debaters have agency within format",
    },
    decomposition: {
      level: "ADVERSARIAL SPLIT",
      note: "Two perspectives, not task decomposition",
    },
    oversight: {
      level: "HUMAN JUDGE",
      note: "Human evaluates which argument wins",
    },
    whitebox: {
      level: "MEDIUM",
      note: "Arguments visible; model internals opaque",
    },
    modularity: { level: "MEDIUM", note: "Clear debater separation" },
    verifiable: { level: "LOW", note: "Hard to verify truth advantage holds" },
    sources: [
      {
        title: "AI Safety via Debate",
        url: "https://arxiv.org/abs/1805.00899",
        year: "2018",
      },
      {
        title: "Debate improves judge accuracy",
        url: "https://arxiv.org/abs/2402.06782",
        year: "2024",
      },
    ],
    safetyPros: [
      "Forces consideration of counterarguments",
      "Truth advantage theory",
      "Externalized reasoning",
    ],
    safetyCons: [
      "Sophisticated deception may win",
      "Confidence escalation",
      "Complex reasoning struggles",
    ],
  },
  {
    id: "ida-amplification",
    category: "oversight",
    name: "IDA / Iterated Amplification",
    description:
      "Christiano. Amplify weak agents via delegation, distill to faster models, iterate. Recursive decomposition. Related to AlphaGoZero.",
    adoption: "LOW",
    adoptionNote: "Training methodology; research stage",
    timeline: "Research stage",
    safetyOutlook: {
      rating: "mixed",
      score: 6,
      summary: "Theoretical promise; limited empirical validation",
    },
    agencyLevel: {
      level: "LOW (during training)",
      note: "Weak agents amplified",
    },
    decomposition: {
      level: "RECURSIVE",
      note: "Task → subtasks → copies → integrate",
    },
    oversight: {
      level: "AMPLIFIED HUMAN",
      note: "Human judgment amplified via AI",
    },
    whitebox: {
      level: "MEDIUM",
      note: "Training structure visible; distilled model less so",
    },
    modularity: { level: "MEDIUM", note: "Recursive structure" },
    verifiable: { level: "LOW", note: "Hard to verify alignment preservation" },
    sources: [
      {
        title: "Iterated Distillation and Amplification",
        url: "https://ai-alignment.com/iterated-distillation-and-amplification-157debfd1616",
        year: "2018",
      },
      {
        title: "Supervising strong learners",
        url: "https://arxiv.org/abs/1810.08575",
        year: "2018",
      },
    ],
    safetyPros: [
      "Human values preserved",
      "Recursive safety",
      "Theoretical elegance",
    ],
    safetyCons: [
      "Limited empirical validation",
      "Decomposition limits unclear",
      "Distillation may lose alignment",
    ],
  },
];
