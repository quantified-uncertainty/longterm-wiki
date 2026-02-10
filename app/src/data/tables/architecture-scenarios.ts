/**
 * Intelligence Paradigms / Architecture Scenarios Table Data
 *
 * This file contains data for AI architecture scenarios and intelligence paradigms
 * used in the ArchitectureScenariosTableView table.
 * Separates base architectures (what the model is) from deployment patterns (how it's used).
 */

// Types
export type SafetyOutlook = "favorable" | "mixed" | "challenging" | "unknown";
export type Category = "deployment" | "base-arch" | "alt-compute" | "non-ai";

export interface Link {
  title: string;
  url?: string;
}

export interface LabLink {
  name: string;
  url?: string;
}

export interface Scenario {
  id: string;
  category: Category;
  name: string;
  pageUrl?: string;
  description: string;
  likelihood: string;
  likelihoodNote: string;
  timeline: string;
  safetyOutlook: {
    rating: SafetyOutlook;
    score?: number;
    summary: string;
    keyRisks: string[];
    keyOpportunities: string[];
  };
  whitebox: { level: string; note: string };
  training: { level: string; note: string };
  predictability: { level: string; note: string };
  reprConvergence: { level: string; note: string };
  modularity: { level: string; note: string };
  formalVerifiable: { level: string; note: string };
  researchTractability: { level: string; note: string };
  labs: LabLink[];
  examples: Link[];
  keyPapers: Link[];
  safetyPros: string[];
  safetyCons: string[];
}

// Category metadata
export const CATEGORIES: Record<Category, { label: string; description: string }> = {
  deployment: { label: "Deployment Patterns", description: "How models are orchestrated and used" },
  "base-arch": { label: "Base Architectures", description: "Core neural network architectures" },
  "alt-compute": { label: "Alternative Compute", description: "Non-standard computing substrates" },
  "non-ai": { label: "Non-AI Paradigms", description: "Intelligence enhancement without traditional AI" },
};

// Category order for sorting/grouping
export const CATEGORY_ORDER: Category[] = ["deployment", "base-arch", "alt-compute", "non-ai"];

// All scenarios data
export const scenarios: Scenario[] = [
  // === DEPLOYMENT PATTERNS (how models are used) ===
  {
    id: "minimal-scaffolding",
    category: "deployment",
    name: "Minimal Scaffolding",
    pageUrl: "/knowledge-base/intelligence-paradigms/minimal-scaffolding",
    description:
      "Direct model API/chat with basic prompting. No persistent memory, minimal tools. Like ChatGPT web interface.",
    likelihood: "5-15%",
    likelihoodNote: "Unlikely to stay dominant - scaffolding adds clear value",
    timeline: "Now (declining)",
    safetyOutlook: {
      rating: "mixed",
      score: 5,
      summary:
        "Easy to study but limited interpretability; low capability ceiling reduces risk",
      keyRisks: ["Model internals opaque", "Deception possible in base model"],
      keyOpportunities: [
        "Simple threat model",
        "Easier red-teaming",
        "Limited action space",
      ],
    },
    researchTractability: {
      level: "HIGH",
      note: "Well-studied; most interp work applies",
    },
    whitebox: { level: "LOW", note: "Model internals opaque; just see inputs/outputs" },
    training: { level: "HIGH", note: "Standard RLHF on base model" },
    predictability: { level: "MEDIUM", note: "Single forward pass, somewhat predictable" },
    reprConvergence: { level: "N/A", note: "Depends on base model" },
    modularity: { level: "LOW", note: "Monolithic model" },
    formalVerifiable: { level: "LOW", note: "Model itself unverifiable" },
    labs: [
      { name: "OpenAI", url: "/knowledge-base/organizations/labs/openai" },
      { name: "Anthropic", url: "/knowledge-base/organizations/labs/anthropic" },
      { name: "Google DeepMind", url: "/knowledge-base/organizations/labs/deepmind" },
    ],
    examples: [
      { title: "ChatGPT", url: "https://chat.openai.com" },
      { title: "Claude.ai", url: "https://claude.ai" },
      { title: "Gemini", url: "https://gemini.google.com" },
    ],
    keyPapers: [
      { title: "InstructGPT (2022)", url: "https://arxiv.org/abs/2203.02155" },
      { title: "Constitutional AI (2022)", url: "https://arxiv.org/abs/2212.08073" },
    ],
    safetyPros: ["Simple to analyze", "No tool access = limited harm"],
    safetyCons: ["Model internals opaque", "Limited capability ceiling"],
  },
  {
    id: "light-scaffolding",
    category: "deployment",
    name: "Light Scaffolding",
    pageUrl: "/knowledge-base/intelligence-paradigms/light-scaffolding",
    description:
      "Model + basic tool use + simple chains. RAG, function calling, single-agent loops. Like GPT with plugins.",
    likelihood: "15-25%",
    likelihoodNote: "Current sweet spot; but heavy scaffolding catching up",
    timeline: "Now - 2027",
    safetyOutlook: {
      rating: "mixed",
      score: 5,
      summary:
        "Tool use adds capability and risk; scaffold provides some inspection",
      keyRisks: [
        "Tool access enables real-world harm",
        "Prompt injection vulnerabilities",
      ],
      keyOpportunities: [
        "Tool permissions controllable",
        "Scaffold code auditable",
        "Bounded context windows",
      ],
    },
    researchTractability: {
      level: "HIGH",
      note: "Active research area; tools well-understood",
    },
    whitebox: { level: "MEDIUM", note: "Scaffold code readable; model still opaque" },
    training: { level: "HIGH", note: "Model trained; scaffold is code" },
    predictability: { level: "MEDIUM", note: "Tool calls add some unpredictability" },
    reprConvergence: { level: "N/A", note: "Scaffold is explicit code" },
    modularity: { level: "MEDIUM", note: "Clear tool boundaries" },
    formalVerifiable: { level: "PARTIAL", note: "Scaffold code can be verified" },
    labs: [
      { name: "OpenAI", url: "/knowledge-base/organizations/labs/openai" },
      { name: "Anthropic", url: "/knowledge-base/organizations/labs/anthropic" },
      { name: "Cohere" },
    ],
    examples: [
      { title: "GPT-4 with plugins" },
      { title: "Claude with tools" },
      { title: "RAG systems" },
    ],
    keyPapers: [
      { title: "Toolformer (2023)", url: "https://arxiv.org/abs/2302.04761" },
      { title: "RAG (2020)", url: "https://arxiv.org/abs/2005.11401" },
    ],
    safetyPros: ["Scaffold logic inspectable", "Tool permissions controllable"],
    safetyCons: ["Tool use enables real-world harm", "Model decisions still opaque"],
  },
  {
    id: "heavy-scaffolding",
    category: "deployment",
    name: "Heavy Scaffolding / Agentic",
    pageUrl: "/knowledge-base/intelligence-paradigms/heavy-scaffolding",
    description:
      "Multi-agent systems, complex orchestration, persistent memory, autonomous operation. Like Claude Code, Devin.",
    likelihood: "25-40%",
    likelihoodNote: "Strong trend; scaffolding getting cheaper and more valuable",
    timeline: "Now - 2030",
    safetyOutlook: {
      rating: "challenging",
      score: 4,
      summary:
        "High capability with emergent behavior; scaffold helps but autonomy is risky",
      keyRisks: [
        "Emergent multi-step deception",
        "Autonomous operation limits oversight",
        "Compounding tool use risks",
      ],
      keyOpportunities: [
        "Code-level safety checks",
        "Modular = can swap components",
        "Explicit decision traces",
      ],
    },
    researchTractability: {
      level: "MEDIUM",
      note: "Emerging field; agent safety understudied",
    },
    whitebox: {
      level: "MEDIUM-HIGH",
      note: "Scaffold code fully readable; model calls are black boxes",
    },
    training: { level: "LOW", note: "Models trained separately; scaffold is engineered code" },
    predictability: { level: "LOW", note: "Multi-step plans diverge unpredictably" },
    reprConvergence: { level: "N/A", note: "Scaffold is code, not representations" },
    modularity: { level: "HIGH", note: "Explicit component architecture" },
    formalVerifiable: { level: "PARTIAL", note: "Scaffold verifiable; model calls not" },
    labs: [
      { name: "Anthropic", url: "/knowledge-base/organizations/labs/anthropic" },
      { name: "Cognition" },
      { name: "OpenAI", url: "/knowledge-base/organizations/labs/openai" },
    ],
    examples: [
      { title: "Claude Code", url: "https://claude.ai/code" },
      { title: "Devin", url: "https://devin.ai" },
      { title: "AutoGPT", url: "https://github.com/Significant-Gravitas/AutoGPT" },
    ],
    keyPapers: [
      { title: "ReAct (2022)", url: "https://arxiv.org/abs/2210.03629" },
      { title: "Voyager (2023)", url: "https://arxiv.org/abs/2305.16291" },
      { title: "Agent protocols" },
    ],
    safetyPros: ["Scaffold code auditable", "Can add safety checks in code", "Modular"],
    safetyCons: ["Emergent multi-step behavior", "Autonomous = less oversight", "Tool use risk"],
  },
  // === BASE NEURAL ARCHITECTURES (what the model is) ===
  {
    id: "dense-transformers",
    category: "base-arch",
    name: "Dense Transformers",
    pageUrl: "/knowledge-base/intelligence-paradigms/dense-transformers",
    description:
      "Standard transformer architecture. All parameters active. Current GPT/Claude/Llama architecture.",
    likelihood: "(base arch)",
    likelihoodNote: "Orthogonal to deployment - combined with scaffolding choices",
    timeline: "Now - ???",
    safetyOutlook: {
      rating: "mixed",
      score: 5,
      summary:
        "Most studied but still opaque; interpretability improving but slowly",
      keyRisks: [
        "Emergent deception",
        "Phase transitions in capabilities",
        "Internals remain opaque at scale",
      ],
      keyOpportunities: [
        "Most interp research applies",
        "Extensive red-teaming",
        "Well-understood training",
      ],
    },
    researchTractability: { level: "HIGH", note: "Most safety research targets this" },
    whitebox: { level: "LOW", note: "Weights exist but mech interp still primitive" },
    training: { level: "HIGH", note: "Well-understood pretraining + RLHF" },
    predictability: { level: "LOW-MED", note: "Emergent capabilities, phase transitions" },
    reprConvergence: { level: "MEDIUM", note: "Some evidence for platonic representations" },
    modularity: { level: "LOW", note: "Monolithic, end-to-end trained" },
    formalVerifiable: { level: "LOW", note: "Billions of parameters, no formal guarantees" },
    labs: [
      { name: "OpenAI", url: "/knowledge-base/organizations/labs/openai" },
      { name: "Anthropic", url: "/knowledge-base/organizations/labs/anthropic" },
      { name: "Google DeepMind", url: "/knowledge-base/organizations/labs/deepmind" },
      { name: "Meta AI" },
    ],
    examples: [
      { title: "GPT-4", url: "https://openai.com/gpt-4" },
      { title: "Claude 3", url: "https://anthropic.com/claude" },
      { title: "Llama 3", url: "https://llama.meta.com" },
      { title: "Gemini", url: "https://deepmind.google/technologies/gemini/" },
    ],
    keyPapers: [
      { title: "Attention Is All You Need (2017)", url: "https://arxiv.org/abs/1706.03762" },
      { title: "Scaling Laws (2020)", url: "https://arxiv.org/abs/2001.08361" },
    ],
    safetyPros: ["Most studied architecture", "Some interp tools exist"],
    safetyCons: [
      "Internals still opaque",
      "Emergent deception possible",
      "Scale makes analysis hard",
    ],
  },
  {
    id: "sparse-moe",
    category: "base-arch",
    name: "Sparse / MoE Transformers",
    pageUrl: "/knowledge-base/intelligence-paradigms/sparse-moe",
    description:
      "Mixture-of-Experts or other sparse architectures. Only subset of params active per token.",
    likelihood: "(base arch)",
    likelihoodNote: "May become default for efficiency; orthogonal to scaffolding",
    timeline: "Now - ???",
    safetyOutlook: {
      rating: "mixed",
      score: 4,
      summary:
        "Efficiency gains good for safety research budget, but routing adds complexity",
      keyRisks: [
        "Routing decisions opaque",
        "Harder to ensure coverage of expert combinations",
        "Less interp research",
      ],
      keyOpportunities: [
        "Expert specialization may aid interpretability",
        "Efficiency = more testing budget",
      ],
    },
    researchTractability: { level: "MEDIUM", note: "Some transfer from dense; routing novel" },
    whitebox: { level: "LOW", note: "Same opacity as dense + routing complexity" },
    training: { level: "HIGH", note: "Standard + load balancing" },
    predictability: { level: "LOW", note: "Routing adds another layer of unpredictability" },
    reprConvergence: { level: "UNKNOWN", note: "Experts may specialize differently" },
    modularity: { level: "MEDIUM", note: "Expert boundaries exist but interact" },
    formalVerifiable: { level: "LOW", note: "Combinatorial explosion of expert paths" },
    labs: [
      { name: "Google DeepMind", url: "/knowledge-base/organizations/labs/deepmind" },
      { name: "Mistral" },
      { name: "xAI", url: "/knowledge-base/organizations/labs/xai" },
    ],
    examples: [
      { title: "Mixtral", url: "https://mistral.ai/news/mixtral-of-experts/" },
      { title: "Switch Transformer", url: "https://arxiv.org/abs/2101.03961" },
      { title: "GPT-4 (rumored)" },
    ],
    keyPapers: [
      { title: "Switch Transformers (2021)", url: "https://arxiv.org/abs/2101.03961" },
      { title: "Mixtral (2024)", url: "https://arxiv.org/abs/2401.04088" },
    ],
    safetyPros: ["Can study individual experts", "More efficient = more testing budget"],
    safetyCons: ["Routing is another black box", "Hard to cover all expert combinations"],
  },
  {
    id: "ssm-hybrid",
    category: "base-arch",
    name: "SSM / Hybrid (Mamba-style)",
    pageUrl: "/knowledge-base/intelligence-paradigms/ssm-mamba",
    description:
      "State-space models or SSM-transformer hybrids with linear-time inference.",
    likelihood: "5-15%",
    likelihoodNote: "Promising efficiency but transformers still dominate benchmarks",
    timeline: "2025-2030",
    safetyOutlook: {
      rating: "unknown",
      score: undefined,
      summary: "Too early to assess; different internals may help or hurt",
      keyRisks: [
        "Existing interp tools don't transfer",
        "Less studied = unknown unknowns",
      ],
      keyOpportunities: [
        "Recurrence might enable new safety analysis",
        "Efficiency gains",
      ],
    },
    researchTractability: { level: "LOW", note: "New architecture; limited safety work" },
    whitebox: { level: "MEDIUM", note: "Different internals, less studied" },
    training: { level: "HIGH", note: "Still gradient-based" },
    predictability: { level: "MEDIUM", note: "Recurrence adds complexity" },
    reprConvergence: { level: "UNKNOWN", note: "Open question" },
    modularity: { level: "LOW", note: "Similar to transformers" },
    formalVerifiable: { level: "UNKNOWN", note: "Recurrence may help or hurt" },
    labs: [{ name: "Cartesia" }, { name: "Together AI" }, { name: "Princeton" }],
    examples: [
      { title: "Mamba", url: "https://arxiv.org/abs/2312.00752" },
      { title: "Mamba-2" },
      { title: "Jamba", url: "https://www.ai21.com/jamba" },
      { title: "Griffin" },
    ],
    keyPapers: [
      { title: "Mamba (Gu & Dao 2023)", url: "https://arxiv.org/abs/2312.00752" },
      { title: "RWKV", url: "https://arxiv.org/abs/2305.13048" },
    ],
    safetyPros: ["More efficient", "Linear complexity"],
    safetyCons: ["Interp tools don't transfer", "Less studied"],
  },
  {
    id: "world-model-planning",
    category: "base-arch",
    name: "World Models + Planning",
    pageUrl: "/knowledge-base/intelligence-paradigms/world-models",
    description:
      "Explicit learned world model with search/planning. More like AlphaGo than GPT.",
    likelihood: "5-15%",
    likelihoodNote: "LeCun advocates; not yet competitive for general tasks",
    timeline: "2026-2032",
    safetyOutlook: {
      rating: "mixed",
      score: 6,
      summary:
        "Explicit structure helps inspection but goal misgeneralization risks higher",
      keyRisks: [
        "Goal misgeneralization",
        "Mesa-optimization risks",
        "Model errors compound in planning",
      ],
      keyOpportunities: [
        "Can inspect world model beliefs",
        "Explicit goals more auditable",
        "Planning traces visible",
      ],
    },
    researchTractability: {
      level: "MEDIUM",
      note: "Different paradigm; some transfer from RL safety",
    },
    whitebox: { level: "PARTIAL", note: "World model inspectable but opaque" },
    training: { level: "HIGH", note: "Model-based RL, self-play" },
    predictability: { level: "MEDIUM", note: "Explicit planning but model errors compound" },
    reprConvergence: { level: "MEDIUM", note: "May converge on physics-like structure" },
    modularity: { level: "MEDIUM", note: "Separate world model, policy, value" },
    formalVerifiable: { level: "PARTIAL", note: "Planning verifiable, world model less so" },
    labs: [
      { name: "Google DeepMind", url: "/knowledge-base/organizations/labs/deepmind" },
      { name: "Meta FAIR" },
      { name: "UC Berkeley" },
    ],
    examples: [
      {
        title: "MuZero",
        url: "https://deepmind.google/discover/blog/muzero-mastering-go-chess-shogi-and-atari-without-rules/",
      },
      { title: "Dreamer v3", url: "https://arxiv.org/abs/2301.04104" },
      { title: "JEPA" },
    ],
    keyPapers: [
      { title: "World Models (Ha 2018)", url: "https://arxiv.org/abs/1803.10122" },
      { title: "MuZero (2020)", url: "https://arxiv.org/abs/1911.08265" },
      { title: "JEPA (LeCun 2022)", url: "https://openreview.net/forum?id=BZ5a1r-kVsf" },
    ],
    safetyPros: ["Explicit goals", "Can inspect beliefs"],
    safetyCons: ["Goal misgeneralization", "Mesa-optimization"],
  },
  {
    id: "hybrid-neurosymbolic",
    category: "base-arch",
    name: "Neuro-Symbolic Hybrid",
    pageUrl: "/knowledge-base/intelligence-paradigms/neuro-symbolic",
    description:
      "Neural + symbolic reasoning, knowledge graphs, or program synthesis.",
    likelihood: "3-10%",
    likelihoodNote: "Long-promised, rarely delivered at scale",
    timeline: "2027-2035",
    safetyOutlook: {
      rating: "favorable",
      score: 7,
      summary:
        "Symbolic components enable formal verification; hybrid boundaries a challenge",
      keyRisks: [
        "Neural-symbolic boundary vulnerabilities",
        "Brittleness in edge cases",
        "Scaling challenges",
      ],
      keyOpportunities: [
        "Symbolic parts formally verifiable",
        "Reasoning traces auditable",
        "Natural language specs",
      ],
    },
    researchTractability: { level: "MEDIUM", note: "Formal methods apply to symbolic parts" },
    whitebox: { level: "PARTIAL", note: "Symbolic parts clear, neural parts opaque" },
    training: { level: "COMPLEX", note: "Neural trainable, symbolic often hand-crafted" },
    predictability: { level: "MEDIUM", note: "Explicit reasoning more auditable" },
    reprConvergence: { level: "HIGH", note: "Symbolic structures standardizable" },
    modularity: { level: "HIGH", note: "Clear neural/symbolic separation" },
    formalVerifiable: { level: "PARTIAL", note: "Symbolic parts formally verifiable" },
    labs: [
      { name: "IBM Research" },
      { name: "Google DeepMind", url: "/knowledge-base/organizations/labs/deepmind" },
      { name: "MIT-IBM Lab" },
    ],
    examples: [
      {
        title: "AlphaProof",
        url: "https://deepmind.google/discover/blog/ai-solves-imo-problems-at-silver-medal-level/",
      },
      {
        title: "AlphaGeometry",
        url: "https://deepmind.google/discover/blog/alphageometry-an-olympiad-level-ai-system-for-geometry/",
      },
      { title: "NeurASP" },
    ],
    keyPapers: [
      { title: "Neural Theorem Provers" },
      { title: "AlphaProof (2024)" },
    ],
    safetyPros: ["Auditable reasoning", "Formal verification possible"],
    safetyCons: ["Brittleness", "Hard to scale", "Boundary problems"],
  },
  {
    id: "provable-bounded",
    category: "base-arch",
    name: "Provable/Guaranteed Safe",
    pageUrl: "/knowledge-base/intelligence-paradigms/provable-safe",
    description:
      "Formally verified AI with mathematical safety guarantees. Davidad's agenda.",
    likelihood: "1-5%",
    likelihoodNote: "Ambitious; unclear if achievable for general capabilities",
    timeline: "2030+",
    safetyOutlook: {
      rating: "favorable",
      score: 9,
      summary:
        "If achievable, best safety properties by design; uncertainty about feasibility",
      keyRisks: [
        "May not achieve competitive capabilities",
        "World model verification hard",
        "Specification gaming",
      ],
      keyOpportunities: [
        "Mathematical guarantees",
        "Auditable by construction",
        "Safety-capability not tradeoff",
      ],
    },
    researchTractability: { level: "LOW", note: "Nascent field; theoretical foundations needed" },
    whitebox: { level: "HIGH", note: "Designed for formal analysis" },
    training: { level: "DIFFERENT", note: "Verified synthesis, not just SGD" },
    predictability: { level: "HIGH", note: "Behavior bounded by proofs" },
    reprConvergence: { level: "N/A", note: "Designed, not learned" },
    modularity: { level: "HIGH", note: "Compositional by design" },
    formalVerifiable: { level: "HIGH", note: "This is the point" },
    labs: [
      { name: "ARIA (Davidad)" },
      { name: "MIRI", url: "/knowledge-base/organizations/safety-orgs/miri" },
    ],
    examples: [{ title: "Open Agency Architecture (proposed)" }],
    keyPapers: [
      { title: "Guaranteed Safe AI (2024)", url: "https://arxiv.org/abs/2405.06624" },
      { title: "Davidad ARIA programme", url: "https://www.aria.org.uk/programme/safeguarded-ai/" },
    ],
    safetyPros: ["Mathematical guarantees", "Auditable by construction"],
    safetyCons: ["May not scale", "Capability tax", "World model verification hard"],
  },
  {
    id: "biological-organic",
    category: "alt-compute",
    name: "Biological / Organoid",
    pageUrl: "/knowledge-base/intelligence-paradigms/biological-organoid",
    description:
      "Actual biological neurons, brain organoids, or wetware computing.",
    likelihood: "<1%",
    likelihoodNote: "Fascinating but far from TAI-relevant scale",
    timeline: "2035+",
    safetyOutlook: {
      rating: "challenging",
      score: 3,
      summary:
        "Deeply opaque; no existing safety tools apply; ethical complexities",
      keyRisks: [
        "No interpretability tools",
        "Ethical status unclear",
        "Biological noise and variability",
      ],
      keyOpportunities: [
        "May share human-like values",
        "Different failure modes than silicon",
      ],
    },
    researchTractability: { level: "LOW", note: "Novel paradigm; neuroscience needed" },
    whitebox: { level: "LOW", note: "Biological systems inherently opaque" },
    training: { level: "UNKNOWN", note: "Biological learning rules" },
    predictability: { level: "LOW", note: "Noisy and variable" },
    reprConvergence: { level: "UNKNOWN", note: "May share human cognitive structure" },
    modularity: { level: "LOW", note: "Highly interconnected" },
    formalVerifiable: { level: "LOW", note: "Too complex" },
    labs: [{ name: "Cortical Labs" }, { name: "Various academic" }],
    examples: [
      {
        title: "DishBrain",
        url: "https://www.cell.com/neuron/fulltext/S0896-6273(22)00806-6",
      },
      { title: "Brain organoids" },
    ],
    keyPapers: [
      {
        title: "DishBrain (Kagan 2022)",
        url: "https://www.cell.com/neuron/fulltext/S0896-6273(22)00806-6",
      },
    ],
    safetyPros: ["May have human-like values", "Energy efficient"],
    safetyCons: ["Ethical concerns", "No interp tools", "Slow iteration"],
  },
  {
    id: "neuromorphic",
    category: "alt-compute",
    name: "Neuromorphic Hardware",
    pageUrl: "/knowledge-base/intelligence-paradigms/neuromorphic",
    description:
      "Spiking neural networks on specialized chips. Event-driven, analog.",
    likelihood: "1-3%",
    likelihoodNote: "Efficiency gains real but not on path to TAI",
    timeline: "2030+",
    safetyOutlook: {
      rating: "unknown",
      score: undefined,
      summary:
        "Different substrate with different properties; too early to assess",
      keyRisks: [
        "Analog dynamics hard to verify",
        "Existing tools don't transfer",
        "Less mature ecosystem",
      ],
      keyOpportunities: [
        "May enable new safety approaches",
        "Energy efficiency for safety testing",
      ],
    },
    researchTractability: { level: "LOW", note: "Different paradigm; limited safety work" },
    whitebox: { level: "PARTIAL", note: "Architecture known, dynamics complex" },
    training: { level: "DIFFERENT", note: "Spike-timing plasticity" },
    predictability: { level: "MEDIUM", note: "More brain-like" },
    reprConvergence: { level: "UNKNOWN", note: "Different substrate" },
    modularity: { level: "MEDIUM", note: "Modular chip designs possible" },
    formalVerifiable: { level: "LOW", note: "Analog dynamics hard to verify" },
    labs: [{ name: "Intel Labs" }, { name: "IBM Research" }, { name: "SynSense" }],
    examples: [
      {
        title: "Loihi 2",
        url: "https://www.intel.com/content/www/us/en/research/neuromorphic-computing.html",
      },
      { title: "TrueNorth" },
      { title: "Akida", url: "https://brainchip.com/akida-neural-processor-soc/" },
    ],
    keyPapers: [
      { title: "Loihi (Intel 2018)", url: "https://ieeexplore.ieee.org/document/8259423" },
      { title: "SpiNNaker", url: "https://apt.cs.manchester.ac.uk/projects/SpiNNaker/" },
    ],
    safetyPros: ["Energy efficient", "Robust"],
    safetyCons: ["Current tools don't transfer", "Less mature"],
  },
  // === NON-AI PARADIGMS ===
  {
    id: "whole-brain-emulation",
    category: "non-ai",
    name: "Whole Brain Emulation",
    pageUrl: "/knowledge-base/intelligence-paradigms/whole-brain-emulation",
    description:
      "Upload/simulate a complete biological brain at sufficient fidelity. Requires scanning + simulation tech.",
    likelihood: "<1%",
    likelihoodNote: "Probably slower than AI; scanning tech far away",
    timeline: "2050+?",
    safetyOutlook: {
      rating: "mixed",
      score: 5,
      summary:
        "Human values by default, but speed-up and copy-ability create novel risks",
      keyRisks: [
        "Fast-forwarding breaks human safeguards",
        "Copy-ability enables coordination risks",
        "Identity/ethics",
      ],
      keyOpportunities: [
        "Human values by default",
        "Understood entity type",
        "Could interview/negotiate",
      ],
    },
    researchTractability: { level: "LOW", note: "Speculative; neuroscience bottleneck" },
    whitebox: { level: "LOW", note: "Brain structure visible but not interpretable" },
    training: { level: "N/A", note: "Copied from biological learning" },
    predictability: { level: "LOW", note: "Human-like = unpredictable" },
    reprConvergence: { level: "HIGH", note: "Same as human brains by definition" },
    modularity: { level: "LOW", note: "Brains are highly interconnected" },
    formalVerifiable: { level: "LOW", note: "Too complex, poorly understood" },
    labs: [{ name: "Carboncopies" }, { name: "Academic neuroscience" }],
    examples: [
      { title: "OpenWorm", url: "https://openworm.org" },
      { title: "Blue Brain Project", url: "https://www.epfl.ch/research/domains/bluebrain/" },
    ],
    keyPapers: [
      {
        title: "Whole Brain Emulation Roadmap (Sandberg 2008)",
        url: "https://www.fhi.ox.ac.uk/brain-emulation-roadmap-report.pdf",
      },
    ],
    safetyPros: ["Human values by default", "Understood entity type"],
    safetyCons: [
      "Ethics of copying minds",
      "Could run faster than real-time",
      "Identity issues",
    ],
  },
  {
    id: "genetic-enhancement",
    category: "non-ai",
    name: "Genetic Enhancement",
    pageUrl: "/knowledge-base/intelligence-paradigms/genetic-enhancement",
    description:
      "IQ enhancement via embryo selection, polygenic screening, or direct genetic engineering.",
    likelihood: "<0.5%",
    likelihoodNote: "Too slow for TAI race; incremental gains only",
    timeline: "2040+",
    safetyOutlook: {
      rating: "favorable",
      score: 7,
      summary:
        "Slow and controllable; enhanced humans still have human values",
      keyRisks: [
        "Inequality/access concerns",
        "Too slow to compete with AI",
        "Ethical opposition",
      ],
      keyOpportunities: [
        "Human values intact",
        "Gradual/controllable",
        "Socially legible",
      ],
    },
    researchTractability: { level: "MEDIUM", note: "Genetics research applicable" },
    whitebox: { level: "LOW", note: "Genetic effects poorly understood" },
    training: { level: "N/A", note: "Biological development" },
    predictability: { level: "MEDIUM", note: "Still human, but smarter" },
    reprConvergence: { level: "HIGH", note: "Human cognitive architecture" },
    modularity: { level: "LOW", note: "Integrated biological system" },
    formalVerifiable: { level: "LOW", note: "Biological complexity" },
    labs: [{ name: "Genomic Prediction" }, { name: "Academic genetics" }],
    examples: [
      { title: "Polygenic embryo screening" },
      { title: "Iterated embryo selection (proposed)" },
    ],
    keyPapers: [
      {
        title: "Embryo Selection for Cognitive Enhancement (Shulman & Bostrom)",
        url: "https://nickbostrom.com/papers/embryo.pdf",
      },
    ],
    safetyPros: ["Human values", "Slow/controllable", "Socially legible"],
    safetyCons: ["Ethical concerns", "Too slow to matter for TAI", "Inequality risks"],
  },
  {
    id: "bci-enhancement",
    category: "non-ai",
    name: "Brain-Computer Interfaces",
    pageUrl: "/knowledge-base/intelligence-paradigms/brain-computer-interfaces",
    description:
      "Neural interfaces that augment human cognition with AI/compute. Neuralink-style.",
    likelihood: "<1%",
    likelihoodNote: "Bandwidth limits; AI likely faster standalone",
    timeline: "2035+",
    safetyOutlook: {
      rating: "mixed",
      score: 5,
      summary:
        "Human oversight built-in, but security risks and bandwidth limits",
      keyRisks: [
        "Security vulnerabilities",
        "Human-AI value conflicts",
        "Bandwidth bottleneck",
      ],
      keyOpportunities: [
        "Human judgment preserved",
        "Gradual augmentation",
        "Value alignment implicit",
      ],
    },
    researchTractability: { level: "LOW", note: "Medical device + AI research needed" },
    whitebox: { level: "PARTIAL", note: "Interface visible, brain opaque" },
    training: { level: "HYBRID", note: "Human learning + AI training" },
    predictability: { level: "LOW", note: "Human in the loop = unpredictable" },
    reprConvergence: { level: "PARTIAL", note: "Hybrid human-AI representations" },
    modularity: { level: "MEDIUM", note: "Clear human/AI boundary" },
    formalVerifiable: { level: "LOW", note: "Human component unverifiable" },
    labs: [{ name: "Neuralink" }, { name: "Synchron" }, { name: "BrainGate" }],
    examples: [
      { title: "Neuralink N1", url: "https://neuralink.com" },
      { title: "Synchron Stentrode", url: "https://synchron.com" },
      { title: "BrainGate", url: "https://www.braingate.org" },
    ],
    keyPapers: [
      {
        title: "Neuralink whitepaper (2019)",
        url: "https://www.biorxiv.org/content/10.1101/703801v4",
      },
    ],
    safetyPros: ["Human oversight built-in", "Gradual augmentation"],
    safetyCons: ["Bandwidth limits", "Security risks", "Human bottleneck"],
  },
  {
    id: "collective-intelligence",
    category: "non-ai",
    name: "Collective/Hybrid Intelligence",
    pageUrl: "/knowledge-base/intelligence-paradigms/collective-intelligence",
    description:
      "Human-AI teams, prediction markets, deliberative democracy augmented by AI. Intelligence from coordination.",
    likelihood: "(overlay)",
    likelihoodNote: "Not exclusive; already happening",
    timeline: "Now",
    safetyOutlook: {
      rating: "favorable",
      score: 7,
      summary:
        "Human oversight natural; slower pace; but coordination challenges",
      keyRisks: [
        "Manipulation by AI",
        "Coordination failures",
        "May not scale to TAI-level tasks",
      ],
      keyOpportunities: [
        "Human oversight natural",
        "Diverse perspectives",
        "Slower = more controllable",
      ],
    },
    researchTractability: { level: "HIGH", note: "Existing social science + CS research" },
    whitebox: { level: "PARTIAL", note: "Process visible, emergent behavior less so" },
    training: { level: "N/A", note: "Coordination protocols, not training" },
    predictability: { level: "MEDIUM", note: "Depends on protocol design" },
    reprConvergence: { level: "N/A", note: "Not a single system" },
    modularity: { level: "HIGH", note: "Explicitly modular by design" },
    formalVerifiable: { level: "PARTIAL", note: "Protocols can be analyzed" },
    labs: [
      { name: "Anthropic", url: "/knowledge-base/organizations/labs/anthropic" },
      { name: "OpenAI", url: "/knowledge-base/organizations/labs/openai" },
      { name: "Metaculus" },
    ],
    examples: [
      { title: "AI-assisted research" },
      { title: "Prediction markets", url: "https://metaculus.com" },
      { title: "Constitutional AI", url: "https://arxiv.org/abs/2212.08073" },
    ],
    keyPapers: [
      {
        title: "Superforecasting (Tetlock)",
        url: "https://goodjudgment.com/superforecasting/",
      },
      { title: "Collective Intelligence papers" },
    ],
    safetyPros: ["Human oversight", "Diverse perspectives", "Slower = more controllable"],
    safetyCons: ["Coordination failures", "Vulnerable to manipulation", "May not scale"],
  },
  {
    id: "novel-unknown",
    category: "base-arch",
    name: "Novel / Unknown Paradigm",
    pageUrl: "/knowledge-base/intelligence-paradigms/novel-unknown",
    description:
      "Something we haven't thought of yet. Placeholder for model uncertainty.",
    likelihood: "5-15%",
    likelihoodNote: "Epistemic humility; history suggests surprises",
    timeline: "???",
    safetyOutlook: {
      rating: "unknown",
      score: undefined,
      summary:
        "Cannot assess; all current safety research may or may not transfer",
      keyRisks: ["All current work may not transfer", "Unknown unknowns"],
      keyOpportunities: ["Fresh start possible", "May be more interpretable"],
    },
    researchTractability: { level: "???", note: "Cannot know" },
    whitebox: { level: "???", note: "Depends on what emerges" },
    training: { level: "???", note: "Unknown" },
    predictability: { level: "???", note: "No basis for prediction" },
    reprConvergence: { level: "???", note: "Unknown" },
    modularity: { level: "???", note: "Unknown" },
    formalVerifiable: { level: "???", note: "Unknown" },
    labs: [{ name: "Unknown" }],
    examples: [{ title: "???" }],
    keyPapers: [],
    safetyPros: ["Fresh start possible"],
    safetyCons: ["All current work may not transfer"],
  },
];
