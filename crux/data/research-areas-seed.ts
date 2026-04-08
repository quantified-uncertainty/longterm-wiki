/**
 * Comprehensive seed data for research areas.
 *
 * Organized by cluster. Each area has:
 * - id: slug used as PK in research_areas table
 * - title: display name
 * - description: 1-2 sentence explanation
 * - cluster: one of the 9 defined clusters
 * - status: active | emerging | mature | declining | archived
 * - parentAreaId: optional parent for hierarchy
 * - firstProposed: brief origin note
 * - firstProposedYear: numeric year for sorting
 * - tags: free-form facets
 *
 * Existing YAML entities (with wikiIds) are included for completeness
 * but their wikiId is NOT set here — the sync endpoint preserves
 * existing wikiIds on conflict update.
 */

export interface ResearchAreaSeed {
  id: string;
  title: string;
  description: string;
  cluster: string;
  status: "active" | "emerging" | "mature" | "declining" | "archived";
  parentAreaId?: string;
  firstProposed?: string;
  firstProposedYear?: number;
  tags: string[];
}

export const RESEARCH_AREAS: ResearchAreaSeed[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // ALIGNMENT TRAINING
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "rlhf",
    title: "RLHF",
    description:
      "Reinforcement Learning from Human Feedback — training technique that fine-tunes AI models using human preference ratings to align outputs with human values.",
    cluster: "alignment-training",
    status: "mature",
    firstProposed: "2017 (Christiano et al.)",
    firstProposedYear: 2017,
    tags: ["training", "human-feedback", "alignment"],
  },
  {
    id: "constitutional-ai",
    title: "Constitutional AI",
    description:
      "Training approach where AI systems critique and revise their own outputs using a set of principles, reducing reliance on human feedback.",
    cluster: "alignment-training",
    status: "active",
    firstProposed: "2022 (Bai et al., Anthropic)",
    firstProposedYear: 2022,
    tags: ["training", "self-supervision", "alignment", "anthropic"],
  },
  {
    id: "preference-optimization",
    title: "Direct Preference Optimization",
    description:
      "Family of training methods (DPO, KTO, GRPO) that optimize language models directly on preference data without a separate reward model.",
    cluster: "alignment-training",
    status: "active",
    firstProposed: "2023 (Rafailov et al.)",
    firstProposedYear: 2023,
    tags: ["training", "preferences", "alignment"],
  },
  {
    id: "reward-modeling",
    title: "Reward Modeling",
    description:
      "Training learned reward functions from human preferences to guide AI optimization, including research on reward hacking and gaming.",
    cluster: "alignment-training",
    status: "active",
    firstProposed: "2017 (Christiano et al.)",
    firstProposedYear: 2017,
    tags: ["training", "reward", "alignment"],
  },
  {
    id: "process-supervision",
    title: "Process Supervision",
    description:
      "Providing feedback on each step of reasoning rather than just final outputs, enabling more reliable chain-of-thought supervision.",
    cluster: "alignment-training",
    status: "emerging",
    firstProposed: "2023 (Lightman et al., OpenAI)",
    firstProposedYear: 2023,
    tags: ["training", "reasoning", "supervision"],
  },
  {
    id: "refusal-training",
    title: "Refusal Training",
    description:
      "Training AI systems to refuse harmful requests while remaining helpful, including safety training and harmlessness optimization.",
    cluster: "alignment-training",
    status: "active",
    tags: ["training", "safety", "harmlessness"],
  },
  {
    id: "adversarial-training",
    title: "Adversarial Training",
    description:
      "Training AI systems to be robust against adversarial inputs and attacks through exposure to adversarial examples during training.",
    cluster: "alignment-training",
    status: "active",
    tags: ["training", "robustness", "adversarial"],
  },
  {
    id: "weak-to-strong",
    title: "Weak-to-Strong Generalization",
    description:
      "Research on whether weak supervisors can effectively train stronger AI systems, a core challenge for superalignment.",
    cluster: "alignment-training",
    status: "emerging",
    firstProposed: "2023 (Burns et al., OpenAI)",
    firstProposedYear: 2023,
    tags: ["superalignment", "supervision", "generalization"],
  },
  {
    id: "robust-unlearning",
    title: "Machine Unlearning",
    description:
      "Techniques for removing specific knowledge or capabilities from trained models, including hazardous knowledge removal.",
    cluster: "alignment-training",
    status: "emerging",
    tags: ["training", "knowledge-removal", "safety"],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // INTERPRETABILITY
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "interpretability",
    title: "Interpretability",
    description:
      "Research field focused on understanding how AI models work internally, encompassing all approaches to model transparency.",
    cluster: "interpretability",
    status: "active",
    tags: ["interpretability", "safety-research"],
  },
  {
    id: "mech-interp",
    title: "Mechanistic Interpretability",
    description:
      "Reverse-engineering neural networks to identify circuits, features, and algorithms that explain behavior at a mechanistic level.",
    cluster: "interpretability",
    status: "active",
    parentAreaId: "interpretability",
    firstProposed: "2020 (Olah et al., Anthropic)",
    firstProposedYear: 2020,
    tags: ["interpretability", "neural-network-analysis", "circuits"],
  },
  {
    id: "sparse-autoencoders",
    title: "Sparse Autoencoders",
    description:
      "Using sparse dictionary learning to decompose neural network activations into interpretable features, enabling monosemanticity research.",
    cluster: "interpretability",
    status: "active",
    parentAreaId: "mech-interp",
    firstProposed: "2023 (Cunningham et al.; Anthropic)",
    firstProposedYear: 2023,
    tags: ["interpretability", "features", "dictionary-learning"],
  },
  {
    id: "representation-engineering",
    title: "Representation Engineering",
    description:
      "Controlling AI behavior by directly manipulating internal representations, including activation addition and steering vectors.",
    cluster: "interpretability",
    status: "emerging",
    parentAreaId: "interpretability",
    firstProposed: "2023 (Zou et al.)",
    firstProposedYear: 2023,
    tags: ["interpretability", "activation-steering", "control"],
  },
  {
    id: "activation-monitoring",
    title: "Activation Monitoring",
    description:
      "Using probes and monitors on model internals to detect deception, harmful intent, or anomalous reasoning in real time.",
    cluster: "interpretability",
    status: "emerging",
    parentAreaId: "interpretability",
    tags: ["interpretability", "monitoring", "probes"],
  },
  {
    id: "externalizing-reasoning",
    title: "Externalizing Reasoning",
    description:
      "Ensuring AI systems' chain-of-thought reasoning faithfully reflects their actual internal computations.",
    cluster: "interpretability",
    status: "emerging",
    parentAreaId: "interpretability",
    tags: ["interpretability", "chain-of-thought", "faithfulness"],
  },
  {
    id: "transparent-architectures",
    title: "Transparent Architectures",
    description:
      "Designing neural network architectures that are inherently more interpretable, as opposed to post-hoc interpretation of opaque models.",
    cluster: "interpretability",
    status: "emerging",
    parentAreaId: "interpretability",
    tags: ["interpretability", "architecture", "design"],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // EVALUATION
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "evals",
    title: "AI Evaluations",
    description:
      "Systematic testing and measurement of AI system capabilities, alignment, and safety properties.",
    cluster: "evaluation",
    status: "active",
    tags: ["evaluations", "safety-research", "testing"],
  },
  {
    id: "red-teaming",
    title: "Red Teaming",
    description:
      "Adversarial testing of AI systems to discover failure modes, safety issues, and vulnerabilities, both manual and automated.",
    cluster: "evaluation",
    status: "active",
    parentAreaId: "evals",
    tags: ["red-teaming", "adversarial", "safety-testing"],
  },
  {
    id: "dangerous-capability-evals",
    title: "Dangerous Capability Evaluations",
    description:
      "Testing AI systems specifically for dangerous capabilities like CBRN knowledge, cyber offense, autonomous replication, and persuasion.",
    cluster: "evaluation",
    status: "active",
    parentAreaId: "evals",
    tags: ["evaluations", "dangerous-capabilities", "cbrn"],
  },
  {
    id: "alignment-evals",
    title: "Alignment Evaluations",
    description:
      "Evaluations specifically designed to measure alignment properties: honesty, helpfulness, harmlessness, and value adherence.",
    cluster: "evaluation",
    status: "active",
    parentAreaId: "evals",
    tags: ["evaluations", "alignment", "safety"],
  },
  {
    id: "sleeper-agent-detection",
    title: "Sleeper Agent Detection",
    description:
      "Research on detecting and mitigating backdoors, trojans, and time-delayed deceptive behavior in AI systems.",
    cluster: "evaluation",
    status: "emerging",
    parentAreaId: "evals",
    firstProposed: "2024 (Hubinger et al., Anthropic)",
    firstProposedYear: 2024,
    tags: ["evaluations", "backdoors", "deception"],
  },
  {
    id: "scheming-detection",
    title: "Scheming Detection",
    description:
      "Research on detecting when AI systems are engaged in deceptive alignment or strategic manipulation of their training process.",
    cluster: "evaluation",
    status: "emerging",
    parentAreaId: "evals",
    tags: ["evaluations", "deception", "deceptive-alignment"],
  },
  {
    id: "alignment-faking",
    title: "Alignment Faking",
    description:
      "Research on whether and how AI systems might pretend to be aligned during evaluation while pursuing different goals at deployment.",
    cluster: "evaluation",
    status: "emerging",
    parentAreaId: "evals",
    firstProposed: "2024 (Greenblatt et al., Anthropic)",
    firstProposedYear: 2024,
    tags: ["evaluations", "deception", "alignment"],
  },
  {
    id: "jailbreak-research",
    title: "Jailbreak Research",
    description:
      "Research on prompt injection, jailbreaking attacks, and defenses for language model safety filters.",
    cluster: "evaluation",
    status: "active",
    parentAreaId: "evals",
    tags: ["evaluations", "adversarial", "prompt-injection"],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // AI CONTROL
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "ai-control",
    title: "AI Control",
    description:
      "Research on deploying AI systems with sufficient safeguards even if they are misaligned, using monitoring, sandboxing, and redundancy.",
    cluster: "ai-control",
    status: "active",
    firstProposed: "2023 (Greenblatt et al., Redwood Research)",
    firstProposedYear: 2023,
    tags: ["ai-control", "safety-research", "deployment"],
  },
  {
    id: "sandboxing",
    title: "Sandboxing and Containment",
    description:
      "Isolating AI systems in controlled environments to limit their ability to cause harm, including air-gapped execution and capability restrictions.",
    cluster: "ai-control",
    status: "active",
    parentAreaId: "ai-control",
    tags: ["containment", "isolation", "deployment-safety"],
  },
  {
    id: "monitoring-anomaly-detection",
    title: "Monitoring and Anomaly Detection",
    description:
      "Runtime monitoring of AI system behavior to detect unexpected actions, policy violations, or anomalous patterns.",
    cluster: "ai-control",
    status: "active",
    parentAreaId: "ai-control",
    tags: ["monitoring", "anomaly-detection", "runtime-safety"],
  },
  {
    id: "multi-agent-safety",
    title: "Multi-Agent Safety",
    description:
      "Safety challenges arising from multiple AI agents interacting, including collusion, coordination failures, and emergent behaviors.",
    cluster: "ai-control",
    status: "emerging",
    parentAreaId: "ai-control",
    tags: ["multi-agent", "coordination", "emergence"],
  },
  {
    id: "encoded-reasoning-detection",
    title: "Encoded Reasoning Detection",
    description:
      "Detecting when AI systems use steganography, hidden channels, or encoded communication to circumvent oversight.",
    cluster: "ai-control",
    status: "emerging",
    parentAreaId: "ai-control",
    tags: ["steganography", "hidden-communication", "oversight-evasion"],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SCALABLE OVERSIGHT
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "scalable-oversight",
    title: "Scalable Oversight",
    description:
      "Research on supervising AI systems that approach or exceed human-level capabilities in specific domains.",
    cluster: "scalable-oversight",
    status: "active",
    tags: ["scalable-oversight", "supervision", "safety-research"],
  },
  {
    id: "corrigibility",
    title: "Corrigibility",
    description:
      "Research on building AI systems that allow themselves to be corrected, modified, or shut down by human operators.",
    cluster: "scalable-oversight",
    status: "active",
    parentAreaId: "scalable-oversight",
    firstProposed: "2015 (Soares et al., MIRI)",
    firstProposedYear: 2015,
    tags: ["corrigibility", "shutdown", "safety-research"],
  },
  {
    id: "debate",
    title: "AI Safety via Debate",
    description:
      "Using structured debate between AI systems as a scalable mechanism for humans to judge the quality of AI reasoning.",
    cluster: "scalable-oversight",
    status: "active",
    parentAreaId: "scalable-oversight",
    firstProposed: "2018 (Irving, Christiano, Amodei)",
    firstProposedYear: 2018,
    tags: ["debate", "oversight", "alignment"],
  },
  {
    id: "elk",
    title: "Eliciting Latent Knowledge",
    description:
      "Extracting what an AI model 'actually believes' rather than what it says, addressing the distinction between model knowledge and model outputs.",
    cluster: "scalable-oversight",
    status: "active",
    parentAreaId: "scalable-oversight",
    firstProposed: "2022 (Christiano et al., ARC)",
    firstProposedYear: 2022,
    tags: ["elk", "knowledge-elicitation", "alignment"],
  },
  {
    id: "formal-verification",
    title: "Formal Verification for AI",
    description:
      "Applying mathematical proof techniques to verify safety properties of neural networks and AI systems.",
    cluster: "scalable-oversight",
    status: "emerging",
    parentAreaId: "scalable-oversight",
    tags: ["formal-methods", "formal-verification", "proofs"],
  },
  {
    id: "value-learning",
    title: "Value Learning",
    description:
      "Research on AI systems that learn and internalize human values through interaction, observation, or inference.",
    cluster: "scalable-oversight",
    status: "active",
    parentAreaId: "scalable-oversight",
    firstProposed: "2016 (Hadfield-Menell et al.)",
    firstProposedYear: 2016,
    tags: ["value-learning", "alignment", "inverse-rl"],
  },
  {
    id: "agent-foundations",
    title: "Agent Foundations",
    description:
      "Theoretical research on the foundations of goal-directed AI agents, including decision theory, logical uncertainty, and embedded agency.",
    cluster: "scalable-oversight",
    status: "active",
    firstProposed: "2014 (MIRI)",
    firstProposedYear: 2014,
    tags: ["agent-foundations", "theory", "miri"],
  },
  {
    id: "cooperative-ai",
    title: "Cooperative AI",
    description:
      "Research on AI systems that can effectively cooperate with humans and other AI systems, including game-theoretic approaches to alignment.",
    cluster: "scalable-oversight",
    status: "emerging",
    tags: ["cooperation", "game-theory", "multi-agent"],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // GOVERNANCE
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "compute-governance",
    title: "Compute Governance",
    description:
      "Using compute as a lever for AI governance: tracking chip flows, export controls, and hardware-enabled safety mechanisms.",
    cluster: "governance",
    status: "active",
    firstProposed: "2023 (Sastry et al.)",
    firstProposedYear: 2023,
    tags: ["governance", "compute", "export-controls"],
  },
  {
    id: "responsible-scaling",
    title: "Responsible Scaling Policies",
    description:
      "Frameworks that tie AI development milestones to safety requirements, including RSPs, preparedness frameworks, and frontier safety commitments.",
    cluster: "governance",
    status: "active",
    firstProposed: "2023 (Anthropic RSP)",
    firstProposedYear: 2023,
    tags: ["governance", "scaling", "safety-commitments"],
  },
  {
    id: "international-coordination",
    title: "International AI Coordination",
    description:
      "Research on international agreements, treaties, and institutions for governing advanced AI development across nations.",
    cluster: "governance",
    status: "active",
    tags: ["governance", "international", "coordination", "treaties"],
  },
  {
    id: "frontier-model-regulation",
    title: "Frontier Model Regulation",
    description:
      "Policy research on regulating the most capable AI models, including licensing, mandatory evaluations, and liability frameworks.",
    cluster: "governance",
    status: "active",
    tags: ["governance", "regulation", "frontier-models", "policy"],
  },
  {
    id: "ai-standards",
    title: "AI Safety Standards",
    description:
      "Development of technical standards, certifications, and audit frameworks for AI safety, including work at NIST, ISO, and industry bodies.",
    cluster: "governance",
    status: "emerging",
    tags: ["governance", "standards", "certification", "auditing"],
  },
  {
    id: "open-source-policy",
    title: "Open-Source AI Policy",
    description:
      "Policy research on the safety implications of open-weight model releases, including dual-use risks and benefits of open development.",
    cluster: "governance",
    status: "active",
    tags: ["governance", "open-source", "model-release", "dual-use"],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CAPABILITIES RESEARCH (safety-relevant)
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "scaling-laws",
    title: "Scaling Laws",
    description:
      "Empirical research on how AI capabilities scale with compute, data, and parameters, crucial for forecasting future capabilities.",
    cluster: "capabilities-research",
    status: "active",
    firstProposed: "2020 (Kaplan et al., OpenAI)",
    firstProposedYear: 2020,
    tags: ["scaling", "capabilities", "forecasting"],
  },
  {
    id: "situational-awareness",
    title: "Situational Awareness",
    description:
      "Research on AI systems' understanding of their own situation, training process, and ability to strategically reason about their environment.",
    cluster: "capabilities-research",
    status: "emerging",
    firstProposed: "2023 (Berglund et al.)",
    firstProposedYear: 2023,
    tags: ["self-knowledge", "agency", "capabilities"],
  },
  {
    id: "ai-forecasting",
    title: "AI Forecasting",
    description:
      "Forecasting AI capabilities, timelines, and societal impacts using prediction markets, expert surveys, and trend extrapolation.",
    cluster: "capabilities-research",
    status: "active",
    tags: ["forecasting", "timelines", "prediction-markets"],
  },
  {
    id: "emergent-capabilities",
    title: "Emergent Capabilities",
    description:
      "Research on capabilities that appear unexpectedly at scale, understanding phase transitions and discontinuous jumps in AI systems.",
    cluster: "capabilities-research",
    status: "active",
    firstProposed: "2022 (Wei et al., Google)",
    firstProposedYear: 2022,
    tags: ["emergence", "scaling", "capabilities"],
  },
  {
    id: "agentic-ai-safety",
    title: "Agentic AI Safety",
    description:
      "Safety challenges specific to AI agents that take actions in the world: tool use, long-horizon planning, autonomous operation.",
    cluster: "capabilities-research",
    status: "emerging",
    tags: ["agents", "tool-use", "autonomy", "planning"],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // INFORMATION INTEGRITY
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "deepfake-detection",
    title: "Deepfake Detection",
    description:
      "Detecting AI-generated or manipulated media including images, audio, and video, as generative capabilities outpace detection.",
    cluster: "information-integrity",
    status: "active",
    tags: ["deepfakes", "detection", "synthetic-media"],
  },
  {
    id: "content-authentication",
    title: "Content Authentication",
    description:
      "Technical standards and tools for establishing content provenance, including C2PA, digital watermarking, and cryptographic provenance.",
    cluster: "information-integrity",
    status: "active",
    tags: ["provenance", "watermarking", "c2pa", "authentication"],
  },
  {
    id: "hallucination-reduction",
    title: "Hallucination Reduction",
    description:
      "Research on reducing false or fabricated outputs in language models, including grounding, retrieval augmentation, and factuality training.",
    cluster: "information-integrity",
    status: "active",
    tags: ["hallucination", "grounding", "factuality"],
  },
  {
    id: "sycophancy-research",
    title: "Sycophancy Research",
    description:
      "Research on AI systems' tendency to tell users what they want to hear rather than the truth, and methods to reduce it.",
    cluster: "information-integrity",
    status: "emerging",
    firstProposed: "2023 (Perez et al., Anthropic)",
    firstProposedYear: 2023,
    tags: ["sycophancy", "honesty", "truthfulness"],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // BIOSECURITY
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "ai-biosecurity",
    title: "AI Biosecurity",
    description:
      "Research on preventing AI systems from being used to create biological weapons, including uplift evaluations and knowledge safeguards.",
    cluster: "biosecurity",
    status: "active",
    tags: ["biosecurity", "bioweapons", "cbrn", "dual-use"],
  },
  {
    id: "dual-use-research",
    title: "Dual-Use Research Governance",
    description:
      "Governance frameworks for research that could be used for both beneficial and harmful purposes, particularly in biology and cybersecurity.",
    cluster: "biosecurity",
    status: "active",
    tags: ["dual-use", "governance", "biosecurity", "cybersecurity"],
  },
];
