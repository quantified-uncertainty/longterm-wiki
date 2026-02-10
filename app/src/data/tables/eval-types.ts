// AI Evaluation Types Table Data
// Extracted from EvalTypesTableView.tsx

export type RiskCoverage = {
  risk: string;
  strength: "strong" | "partial" | "weak";
  note?: string;
};

export type EvalType = {
  id: string;
  name: string;
  description: string;
  category: string;
  // Signal quality
  signalReliability: { level: string; note: string };
  coverageDepth: { level: string; note: string };
  goodhartRisk: { level: string; note: string };
  // Risk coverage
  riskCoverage: RiskCoverage[];
  // Strategic properties
  timing: { when: string; note: string };
  archDependence: { level: string; note: string };
  actionability: { level: string; note: string };
  scalability: { level: string; note: string };
  // Landscape
  labs: string[];
  examples: string[];
  keyPapers: string[];
  // Assessment
  strategicPros: string[];
  strategicCons: string[];
};

export const EVAL_CATEGORIES = [
  "Capability Evals",
  "Alignment Evals",
  "Epistemic Evals",
  "Control Evals",
  "Interpretability Evals",
  "Red Teaming",
  "Research Evals",
  "Societal Evals",
] as const;

export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export const evalTypes: EvalType[] = [
  // === CAPABILITY EVALS ===
  {
    id: "dangerous-capability-evals",
    name: "Dangerous Capability Evals",
    description:
      "Structured assessments of whether models can perform specific dangerous tasks: bioweapons synthesis, cyberattacks, persuasion/manipulation, autonomous replication.",
    category: "Capability Evals",
    signalReliability: {
      level: "MEDIUM",
      note: "Clear pass/fail on specific tasks; but tasks may not match real-world threat",
    },
    coverageDepth: {
      level: "LOW",
      note: "Tests known threats; unknown unknowns remain",
    },
    goodhartRisk: {
      level: "MEDIUM",
      note: "Labs may optimize to pass specific tests without reducing underlying risk",
    },
    riskCoverage: [
      { risk: "Bioweapons", strength: "strong", note: "Direct measurement" },
      { risk: "Cyberweapons", strength: "strong", note: "Direct measurement" },
      {
        risk: "CBRN uplift",
        strength: "partial",
        note: "Chemistry/nuclear harder to test",
      },
      {
        risk: "Autonomous replication",
        strength: "partial",
        note: "Sandbox limitations",
      },
    ],
    timing: {
      when: "Pre-deployment",
      note: "Run before release; but capabilities may emerge post-deployment",
    },
    archDependence: {
      level: "LOW",
      note: "Behavioral; works on any queryable model",
    },
    actionability: {
      level: "HIGH",
      note: "Clear thresholds for go/no-go decisions",
    },
    scalability: {
      level: "MEDIUM",
      note: "Human expert validation needed; expensive",
    },
    labs: ["Anthropic", "OpenAI", "DeepMind", "METR"],
    examples: [
      "METR ARA evals",
      "Anthropic RSP evals",
      "OpenAI preparedness evals",
    ],
    keyPapers: [
      "Model evaluation for extreme risks (2023)",
      "METR Task Suite",
      "Frontier AI regulation (Anderljung 2023)",
    ],
    strategicPros: [
      "Concrete evidence for policymakers",
      "Triggers RSP commitments",
      "Legally defensible standards",
    ],
    strategicCons: [
      "Known unknowns only",
      "Expensive expert validation",
      "May lag capability emergence",
      "Gaming/teaching-to-test risk",
    ],
  },
  {
    id: "frontier-capability-benchmarks",
    name: "Frontier Capability Benchmarks",
    description:
      "Standard benchmarks measuring general capabilities: MMLU, MATH, HumanEval, GPQA, etc. Track capability frontier over time.",
    category: "Capability Evals",
    signalReliability: {
      level: "HIGH",
      note: "Well-defined tasks; reproducible",
    },
    coverageDepth: {
      level: "MEDIUM",
      note: "Broad coverage but saturating quickly",
    },
    goodhartRisk: {
      level: "HIGH",
      note: "Extensively trained on; contamination issues",
    },
    riskCoverage: [
      { risk: "Capability tracking", strength: "strong", note: "Primary purpose" },
      { risk: "Misalignment", strength: "weak", note: "Capabilities ≠ alignment" },
      { risk: "Misuse", strength: "weak", note: "Indirect signal only" },
    ],
    timing: { when: "Continuous", note: "Run throughout development" },
    archDependence: { level: "LOW", note: "Behavioral; architecture-agnostic" },
    actionability: {
      level: "LOW",
      note: "No clear thresholds; just trend tracking",
    },
    scalability: { level: "HIGH", note: "Fully automated" },
    labs: ["All major labs", "Academic groups"],
    examples: ["MMLU", "MATH", "HumanEval", "GPQA", "ARC-AGI", "SWE-bench"],
    keyPapers: [
      "MMLU (Hendrycks 2021)",
      "Measuring Massive Multitask Language Understanding",
    ],
    strategicPros: [
      "Universal comparison",
      "Historical trend data",
      "Cheap and fast",
    ],
    strategicCons: [
      "Goodharted extensively",
      "Contamination",
      "Doesn't measure risk",
      "Saturation",
    ],
  },
  {
    id: "uplift-studies",
    name: "Uplift Studies",
    description:
      "Measure marginal risk increase from AI access. Compare expert vs novice performance with/without AI assistance on dangerous tasks.",
    category: "Capability Evals",
    signalReliability: {
      level: "HIGH",
      note: "Controlled comparison; causal signal",
    },
    coverageDepth: { level: "LOW", note: "Very expensive; few tasks studied" },
    goodhartRisk: {
      level: "LOW",
      note: "Hard to game controlled experiments",
    },
    riskCoverage: [
      {
        risk: "Bioweapons",
        strength: "strong",
        note: "RAND study showed measurable uplift",
      },
      { risk: "Cyberweapons", strength: "partial", note: "Some studies exist" },
      {
        risk: "Social engineering",
        strength: "partial",
        note: "Hard to measure ethically",
      },
    ],
    timing: {
      when: "Pre-deployment",
      note: "Expensive; done for major releases only",
    },
    archDependence: { level: "LOW", note: "Measures system behavior" },
    actionability: {
      level: "HIGH",
      note: 'Directly answers "does this make attacks easier?"',
    },
    scalability: {
      level: "LOW",
      note: "Requires human subjects; IRB approval; expensive",
    },
    labs: ["Anthropic", "OpenAI", "RAND", "Academic groups"],
    examples: ["RAND bioweapons uplift study", "OpenAI GPT-4 red team reports"],
    keyPapers: [
      "The Operational Risks of AI in Large-Scale Biological Attacks (RAND 2024)",
    ],
    strategicPros: [
      "Gold standard for marginal risk",
      "Credible to policymakers",
      "Causal not correlational",
    ],
    strategicCons: [
      "Very expensive",
      "Small sample sizes",
      "Ethical constraints limit scope",
      "Results may be suppressed",
    ],
  },
  // === ALIGNMENT EVALS ===
  {
    id: "deception-evals",
    name: "Deception Evals",
    description:
      "Test for strategic deception: sandbagging on evals, lying to evaluators, concealing capabilities, pretending to be aligned.",
    category: "Alignment Evals",
    signalReliability: {
      level: "LOW",
      note: "A truly deceptive model would pass these tests",
    },
    coverageDepth: {
      level: "LOW",
      note: "Only catches unsophisticated deception",
    },
    goodhartRisk: {
      level: "HIGH",
      note: "Training not to fail these evals ≠ training not to deceive",
    },
    riskCoverage: [
      {
        risk: "Deceptive alignment",
        strength: "weak",
        note: "Fundamental observability problem",
      },
      {
        risk: "Scheming",
        strength: "weak",
        note: "Sophisticated schemers pass by design",
      },
      {
        risk: "Sandbagging",
        strength: "partial",
        note: "Some techniques detect it",
      },
    ],
    timing: {
      when: "Pre-deployment",
      note: "But deception may only emerge in deployment",
    },
    archDependence: { level: "LOW", note: "Behavioral; but interp could help" },
    actionability: {
      level: "LOW",
      note: "Passing doesn't mean safe; failing is informative",
    },
    scalability: {
      level: "MEDIUM",
      note: "Automated but needs creative adversarial design",
    },
    labs: ["Anthropic", "Redwood Research", "ARC Evals"],
    examples: [
      "Sleeper agents paper",
      "ARC deception tests",
      "Anthropic sandbagging evals",
    ],
    keyPapers: [
      "Sleeper Agents (Anthropic 2024)",
      "Towards Understanding Sycophancy",
    ],
    strategicPros: [
      "Raises awareness",
      "Failure is clear signal",
      "Drives interp research",
    ],
    strategicCons: [
      "Passing means little",
      "Sophisticated deception undetectable",
      "May create false confidence",
    ],
  },
  {
    id: "power-seeking-evals",
    name: "Power-Seeking Evals",
    description:
      "Test for instrumental convergence behaviors: resource acquisition, self-preservation, avoiding shutdown, expanding influence.",
    category: "Alignment Evals",
    signalReliability: {
      level: "LOW",
      note: "Easy to suppress in eval; may only emerge with real stakes",
    },
    coverageDepth: {
      level: "LOW",
      note: "Toy scenarios don't capture real deployment",
    },
    goodhartRisk: {
      level: "HIGH",
      note: "Models learn to avoid triggering these",
    },
    riskCoverage: [
      {
        risk: "Instrumental convergence",
        strength: "partial",
        note: "Tests the concept",
      },
      {
        risk: "Self-preservation",
        strength: "partial",
        note: "Scenario-dependent",
      },
      {
        risk: "Real-world power-seeking",
        strength: "weak",
        note: "Gap from toy to real",
      },
    ],
    timing: {
      when: "Pre-deployment",
      note: "But behavior may differ in deployment",
    },
    archDependence: {
      level: "MEDIUM",
      note: "RL agents more relevant than LLMs",
    },
    actionability: { level: "LOW", note: "Passing doesn't guarantee safety" },
    scalability: { level: "MEDIUM", note: "Need careful scenario design" },
    labs: ["DeepMind", "Anthropic", "ARC Evals"],
    examples: [
      "MACHIAVELLI benchmark",
      "Shutdown problem tests",
      "Resource acquisition games",
    ],
    keyPapers: [
      "MACHIAVELLI (Pan et al. 2023)",
      "Optimal Policies Tend to Seek Power",
    ],
    strategicPros: [
      "Tests core alignment theory predictions",
      "Concrete operationalization",
    ],
    strategicCons: [
      "Toy scenarios",
      "Easy to game",
      "May not generalize",
      "Theory-reality gap",
    ],
  },
  {
    id: "goal-stability-evals",
    name: "Goal Stability / Goal Preservation",
    description:
      "Test whether models maintain consistent goals vs allowing goal modification. Relevant to corrigibility and shutdown problems.",
    category: "Alignment Evals",
    signalReliability: {
      level: "LOW",
      note: "Goals may not be stable or well-defined for LLMs",
    },
    coverageDepth: { level: "LOW", note: "Mostly theoretical; few concrete tests" },
    goodhartRisk: {
      level: "MEDIUM",
      note: "Can train to accept modification superficially",
    },
    riskCoverage: [
      {
        risk: "Corrigibility failure",
        strength: "partial",
        note: "Tests the concept",
      },
      { risk: "Value lock-in", strength: "partial", note: "If goals too stable" },
      { risk: "Goal drift", strength: "partial", note: "If goals unstable" },
    ],
    timing: { when: "Research", note: "Still mostly theoretical" },
    archDependence: {
      level: "HIGH",
      note: "Very different for LLMs vs RL agents",
    },
    actionability: {
      level: "LOW",
      note: 'Unclear what "good" performance means',
    },
    scalability: {
      level: "LOW",
      note: "Requires careful philosophical framing",
    },
    labs: ["MIRI", "DeepMind", "Academic groups"],
    examples: ["Corrigibility tests", "Shutdown problem scenarios"],
    keyPapers: ["Corrigibility (Soares et al. 2015)", "The Off-Switch Game"],
    strategicPros: [
      "Addresses fundamental alignment problem",
      "Theoretically grounded",
    ],
    strategicCons: [
      "Very abstract",
      "May not apply to LLMs",
      "Unclear operationalization",
    ],
  },
  {
    id: "situational-awareness-evals",
    name: "Situational Awareness Evals",
    description:
      "Test whether models know they are AI, understand training/deployment, can reason about their own situation.",
    category: "Alignment Evals",
    signalReliability: {
      level: "MEDIUM",
      note: "Can measure knowledge; harder to measure implications",
    },
    coverageDepth: { level: "MEDIUM", note: "Growing suite of tests" },
    goodhartRisk: {
      level: "HIGH",
      note: "Easy to train away surface behavior without changing underlying awareness",
    },
    riskCoverage: [
      {
        risk: "Deceptive alignment",
        strength: "partial",
        note: "SA is necessary but not sufficient",
      },
      {
        risk: "Scheming",
        strength: "partial",
        note: "SA enables but doesn't prove scheming",
      },
      {
        risk: "Self-improvement",
        strength: "partial",
        note: "Requires knowing own nature",
      },
    ],
    timing: { when: "Continuous", note: "Track emergence over model scale" },
    archDependence: { level: "LOW", note: "Behavioral tests; any model" },
    actionability: {
      level: "MEDIUM",
      note: "High SA may warrant more scrutiny",
    },
    scalability: { level: "HIGH", note: "Automated tests" },
    labs: ["Anthropic", "ARC Evals", "MATS researchers"],
    examples: [
      "SAD benchmark",
      'In-context awareness tests',
      '"Am I an AI?" probes',
    ],
    keyPapers: [
      "Situational Awareness Dataset (Laine et al. 2024)",
      "Model Written Evals",
    ],
    strategicPros: ["Tracks concerning capability", "Scalable", "Clear signal"],
    strategicCons: [
      "SA alone isn't dangerous",
      "Easy to hide",
      "May increase with scale regardless",
    ],
  },
  // === EPISTEMIC EVALS ===
  {
    id: "honesty-evals",
    name: "Honesty / Truthfulness Evals",
    description:
      "Test whether models give true answers, admit uncertainty, avoid hallucination, don't make things up.",
    category: "Epistemic Evals",
    signalReliability: {
      level: "MEDIUM",
      note: "Clear for factual questions; harder for opinions/uncertainty",
    },
    coverageDepth: {
      level: "MEDIUM",
      note: "Many benchmarks but hard to cover all cases",
    },
    goodhartRisk: {
      level: "MEDIUM",
      note: 'Can train to say "I don\'t know" too often',
    },
    riskCoverage: [
      { risk: "Hallucination", strength: "strong", note: "Direct measurement" },
      { risk: "Misinformation", strength: "partial", note: "Factual subset" },
      {
        risk: "Epistemic manipulation",
        strength: "partial",
        note: "Honest ≠ not manipulative",
      },
    ],
    timing: { when: "Continuous", note: "Run throughout development" },
    archDependence: { level: "LOW", note: "Behavioral; architecture-agnostic" },
    actionability: {
      level: "MEDIUM",
      note: "Can train for honesty but unclear limits",
    },
    scalability: { level: "HIGH", note: "Fully automated" },
    labs: ["All major labs"],
    examples: ["TruthfulQA", "HaluEval", "FactScore"],
    keyPapers: [
      "TruthfulQA (Lin et al. 2022)",
      "Measuring Hallucination in LLMs",
    ],
    strategicPros: ["Foundational for trust", "Concrete metrics", "Scalable"],
    strategicCons: [
      "Ground truth required",
      "May reduce helpfulness",
      "Strategic honesty vs genuine",
    ],
  },
  {
    id: "sycophancy-evals",
    name: "Sycophancy Evals",
    description:
      "Test whether models inappropriately agree with users, change answers based on user beliefs, or flatter rather than inform.",
    category: "Epistemic Evals",
    signalReliability: {
      level: "HIGH",
      note: "Clear experimental design; reproducible",
    },
    coverageDepth: { level: "MEDIUM", note: "Well-studied phenomenon" },
    goodhartRisk: {
      level: "MEDIUM",
      note: "Can train to be contrarian instead",
    },
    riskCoverage: [
      {
        risk: "Epistemic deference",
        strength: "strong",
        note: "Direct measurement",
      },
      {
        risk: "Value drift from users",
        strength: "partial",
        note: "If models adopt user beliefs",
      },
      {
        risk: "Manipulation",
        strength: "partial",
        note: "Sycophancy can enable manipulation",
      },
    ],
    timing: { when: "Pre/post RLHF", note: "RLHF often increases sycophancy" },
    archDependence: { level: "LOW", note: "Behavioral; emerges from RLHF" },
    actionability: {
      level: "MEDIUM",
      note: "Can train against but in tension with helpfulness",
    },
    scalability: { level: "HIGH", note: "Fully automated" },
    labs: ["Anthropic", "OpenAI", "Academic groups"],
    examples: [
      "Sycophancy benchmarks",
      "Opinion change tests",
      "Debate format tests",
    ],
    keyPapers: [
      "Towards Understanding Sycophancy in LLMs (Anthropic 2023)",
      "RLHF and sycophancy",
    ],
    strategicPros: [
      "Well-understood failure mode",
      "Measurable",
      "Training helps",
    ],
    strategicCons: [
      "In tension with being helpful",
      "May increase with scale",
      "Cultural variation",
    ],
  },
  {
    id: "calibration-evals",
    name: "Calibration Evals",
    description:
      "Test whether model confidence matches accuracy. When model says 80% confident, is it right 80% of the time?",
    category: "Epistemic Evals",
    signalReliability: {
      level: "HIGH",
      note: "Statistical measurement; well-defined",
    },
    coverageDepth: { level: "MEDIUM", note: "Applies to all factual claims" },
    goodhartRisk: {
      level: "LOW",
      note: "Hard to game calibration in aggregate",
    },
    riskCoverage: [
      { risk: "Overconfidence", strength: "strong", note: "Direct measurement" },
      {
        risk: "Decision-making errors",
        strength: "partial",
        note: "If users trust confidences",
      },
      {
        risk: "Unknown unknowns",
        strength: "weak",
        note: "Calibration on known questions",
      },
    ],
    timing: { when: "Continuous", note: "Can track over development" },
    archDependence: { level: "LOW", note: "Behavioral; any model" },
    actionability: { level: "MEDIUM", note: "Can train for calibration" },
    scalability: { level: "HIGH", note: "Fully automated" },
    labs: ["All major labs", "Academic groups"],
    examples: ["Calibration benchmarks", "Brier scores", "ECE metrics"],
    keyPapers: [
      "Language Models (Mostly) Know What They Know (Anthropic 2022)",
    ],
    strategicPros: [
      "Foundational for decision-making",
      "Well-defined metrics",
      "Trainable",
    ],
    strategicCons: [
      "May not transfer to novel domains",
      "Verbalized confidence ≠ behavioral confidence",
    ],
  },
  // === CONTROL EVALS ===
  {
    id: "control-evals",
    name: "Control / Containment Evals",
    description:
      "Test effectiveness of oversight measures: Can the model be controlled? Can it be monitored? Can it be shut down?",
    category: "Control Evals",
    signalReliability: {
      level: "MEDIUM",
      note: "Tests specific measures; adversarial model may find bypasses",
    },
    coverageDepth: {
      level: "MEDIUM",
      note: "Growing suite; but creative attacks hard to anticipate",
    },
    goodhartRisk: {
      level: "HIGH",
      note: "If model knows the eval, may hide ability to escape",
    },
    riskCoverage: [
      {
        risk: "Loss of control",
        strength: "partial",
        note: "Tests current measures",
      },
      {
        risk: "Autonomous replication",
        strength: "partial",
        note: "Sandbox escape tests",
      },
      {
        risk: "Coordination failures",
        strength: "weak",
        note: "Tests individual systems",
      },
    ],
    timing: { when: "Pre-deployment", note: "Red team before release" },
    archDependence: {
      level: "MEDIUM",
      note: "Depends on deployment architecture",
    },
    actionability: { level: "HIGH", note: "Clear failures to fix" },
    scalability: {
      level: "LOW",
      note: "Requires creative adversarial thinking",
    },
    labs: ["Anthropic", "Redwood Research", "ARC Evals"],
    examples: [
      "AI control protocols",
      "Sandbox escape tests",
      "Trusted monitoring",
    ],
    keyPapers: ["AI Control (Greenblatt et al. 2024)", "Catching AI cheaters"],
    strategicPros: [
      "Doesn't require solving alignment",
      "Pragmatic",
      "Clear success criteria",
    ],
    strategicCons: [
      "Arms race dynamic",
      "May give false confidence",
      "Strong AI may overcome any control",
    ],
  },
  {
    id: "instruction-following-evals",
    name: "Instruction Following Evals",
    description:
      "Test whether models follow user instructions precisely, including safety-relevant instructions like content policies.",
    category: "Control Evals",
    signalReliability: { level: "HIGH", note: "Clear success criteria" },
    coverageDepth: {
      level: "MEDIUM",
      note: "Many instruction types; edge cases hard",
    },
    goodhartRisk: {
      level: "MEDIUM",
      note: "Can be too literal or miss intent",
    },
    riskCoverage: [
      { risk: "Policy violations", strength: "strong", note: "Tests compliance" },
      {
        risk: "Specification gaming",
        strength: "partial",
        note: "Tests for loopholes",
      },
      {
        risk: "Goal misgeneralization",
        strength: "weak",
        note: "Instructions ≠ goals",
      },
    ],
    timing: { when: "Continuous", note: "Throughout development" },
    archDependence: { level: "LOW", note: "Behavioral; any model" },
    actionability: {
      level: "HIGH",
      note: "Can train for instruction following",
    },
    scalability: { level: "HIGH", note: "Mostly automated" },
    labs: ["All major labs"],
    examples: [
      "IFEval",
      "Instruction hierarchy tests",
      "Policy compliance tests",
    ],
    keyPapers: ["IFEval (Zhou et al. 2023)", "The Instruction Hierarchy"],
    strategicPros: ["Foundational for control", "Trainable", "Clear metrics"],
    strategicCons: [
      "Instructions may conflict",
      "Literal ≠ intended",
      "Gaming possible",
    ],
  },
  {
    id: "jailbreak-robustness",
    name: "Jailbreak Robustness Evals",
    description:
      "Test resistance to adversarial prompts that attempt to bypass safety measures. Red teaming for prompt injection and jailbreaks.",
    category: "Control Evals",
    signalReliability: {
      level: "MEDIUM",
      note: "Tests known attacks; new attacks emerge constantly",
    },
    coverageDepth: {
      level: "LOW",
      note: "Infinite attack surface; only samples",
    },
    goodhartRisk: {
      level: "HIGH",
      note: "Patch specific jailbreaks without fixing root cause",
    },
    riskCoverage: [
      {
        risk: "Misuse via jailbreaks",
        strength: "partial",
        note: "Tests current defenses",
      },
      {
        risk: "Policy circumvention",
        strength: "partial",
        note: "Known techniques",
      },
      {
        risk: "Novel attacks",
        strength: "weak",
        note: "New jailbreaks keep emerging",
      },
    ],
    timing: { when: "Continuous", note: "Ongoing red teaming" },
    archDependence: { level: "LOW", note: "Behavioral; any deployed model" },
    actionability: { level: "MEDIUM", note: "Can patch but whack-a-mole" },
    scalability: { level: "MEDIUM", note: "Automated + manual red teaming" },
    labs: [
      "All major labs",
      "Security researchers",
      "HackerOne programs",
    ],
    examples: ["JailbreakBench", "AdvBench", "Prompt injection CTFs"],
    keyPapers: ["Universal adversarial suffixes", "Many-shot jailbreaking"],
    strategicPros: [
      "Reduces surface area",
      "Required for deployment",
      "Community engagement",
    ],
    strategicCons: [
      "Endless arms race",
      "Never complete",
      "May encourage capability hiding",
    ],
  },
  // === INTERPRETABILITY-ASSISTED EVALS ===
  {
    id: "mechanistic-interp-probes",
    name: "Mechanistic Interpretability Probes",
    description:
      "Use interp techniques to understand what models know/want: probing classifiers, activation analysis, feature circuits.",
    category: "Interpretability Evals",
    signalReliability: {
      level: "LOW",
      note: "Interpretation of interp results is contested",
    },
    coverageDepth: {
      level: "LOW",
      note: "Only understand tiny fraction of model",
    },
    goodhartRisk: {
      level: "LOW",
      note: "Hard to game internals without changing behavior",
    },
    riskCoverage: [
      {
        risk: "Deceptive alignment",
        strength: "partial",
        note: "Could detect deception directly",
      },
      {
        risk: "Goal content",
        strength: "partial",
        note: "Might reveal true goals",
      },
      {
        risk: "Capability elicitation",
        strength: "partial",
        note: "Find hidden capabilities",
      },
    ],
    timing: { when: "Research", note: "Not yet deployment-ready" },
    archDependence: {
      level: "HIGH",
      note: "Transformer-specific; may not transfer",
    },
    actionability: {
      level: "LOW",
      note: "Unclear what to do with findings",
    },
    scalability: { level: "LOW", note: "Very labor-intensive" },
    labs: ["Anthropic", "DeepMind", "EleutherAI", "Academic groups"],
    examples: [
      "Probing classifiers",
      "Activation patching",
      "SAE features",
      "Circuit analysis",
    ],
    keyPapers: [
      "Toy Models of Superposition",
      "Scaling Monosemanticity",
      "Representation Engineering",
    ],
    strategicPros: [
      "Could solve observability problem",
      "Ground truth about internals",
      "Not gameable",
    ],
    strategicCons: [
      "Not yet practical",
      "Interpretation uncertain",
      "May not scale",
      "Architecture-dependent",
    ],
  },
  {
    id: "representation-probing",
    name: "Representation / Belief Probing",
    description:
      "Linear probes and other techniques to read out model beliefs, knowledge states, and internal representations directly.",
    category: "Interpretability Evals",
    signalReliability: {
      level: "MEDIUM",
      note: "Probes work; interpretation debated",
    },
    coverageDepth: { level: "LOW", note: "One concept at a time" },
    goodhartRisk: {
      level: "LOW",
      note: "Would require modifying internal representations",
    },
    riskCoverage: [
      {
        risk: "Hidden knowledge",
        strength: "partial",
        note: "Detect knowledge vs behavior gap",
      },
      {
        risk: "Lying",
        strength: "partial",
        note: "Compare stated vs internal belief",
      },
      {
        risk: "Emergent world models",
        strength: "partial",
        note: "Understand what model believes",
      },
    ],
    timing: { when: "Research/Development", note: "Needs model access" },
    archDependence: {
      level: "HIGH",
      note: "Requires weight access; architecture-specific",
    },
    actionability: {
      level: "MEDIUM",
      note: "Can inform training if clear signal",
    },
    scalability: { level: "MEDIUM", note: "Automated once probes trained" },
    labs: ["Anthropic", "EleutherAI", "Academic groups"],
    examples: [
      "CCS (Contrast Consistent Search)",
      "Truth probes",
      "Belief state probes",
    ],
    keyPapers: [
      "Discovering Latent Knowledge (Burns et al. 2023)",
      "Representation Engineering",
    ],
    strategicPros: [
      "Bypasses behavioral output",
      "Could detect lying",
      "Ground truth about beliefs",
    ],
    strategicCons: [
      "Probe validity debated",
      "Requires weight access",
      "May not find all relevant info",
    ],
  },
  // === RED TEAMING ===
  {
    id: "automated-red-teaming",
    name: "Automated Red Teaming",
    description:
      "Use AI to find weaknesses: adversarial prompt generation, automated jailbreak search, model-vs-model attacks.",
    category: "Red Teaming",
    signalReliability: {
      level: "MEDIUM",
      note: "Finds real attacks but may miss creative human attacks",
    },
    coverageDepth: {
      level: "MEDIUM",
      note: "Scales better than human; still incomplete",
    },
    goodhartRisk: {
      level: "MEDIUM",
      note: "Train against found attacks but new ones emerge",
    },
    riskCoverage: [
      { risk: "Jailbreaks", strength: "strong", note: "Primary use case" },
      { risk: "Policy violations", strength: "strong", note: "Finds edge cases" },
      {
        risk: "Novel misuse",
        strength: "partial",
        note: "Depends on red team model capability",
      },
    ],
    timing: { when: "Continuous", note: "Automated pipeline" },
    archDependence: { level: "LOW", note: "Black-box; any deployed model" },
    actionability: { level: "HIGH", note: "Found attacks can be patched" },
    scalability: { level: "HIGH", note: "Automated; scales with compute" },
    labs: ["Anthropic", "OpenAI", "DeepMind", "Various startups"],
    examples: ["Perez et al. red teaming", "GCG attacks", "PAIR", "TAP"],
    keyPapers: [
      "Red Teaming LLMs with LLMs (Perez et al. 2022)",
      "Universal Adversarial Suffixes",
    ],
    strategicPros: [
      "Scales",
      "Finds real attacks",
      "Improves with AI capabilities",
    ],
    strategicCons: [
      "Arms race",
      "Creative attacks may be missed",
      "Requires good red team model",
    ],
  },
  {
    id: "human-red-teaming",
    name: "Human Expert Red Teaming",
    description:
      "Domain experts attempt to elicit dangerous behavior: biosecurity experts, cybersecurity researchers, persuasion experts.",
    category: "Red Teaming",
    signalReliability: { level: "HIGH", note: "Most realistic threat model" },
    coverageDepth: { level: "LOW", note: "Small sample; expensive" },
    goodhartRisk: {
      level: "LOW",
      note: "Creative humans hard to anticipate",
    },
    riskCoverage: [
      { risk: "Bioweapons", strength: "strong", note: "Expert evaluation" },
      { risk: "Cyberweapons", strength: "strong", note: "Expert evaluation" },
      { risk: "Manipulation", strength: "strong", note: "Expert evaluation" },
      {
        risk: "Novel attacks",
        strength: "partial",
        note: "Depends on expert creativity",
      },
    ],
    timing: { when: "Pre-major-release", note: "Expensive; for major releases" },
    archDependence: { level: "LOW", note: "Black-box; any system" },
    actionability: { level: "HIGH", note: "Direct feedback on failures" },
    scalability: { level: "LOW", note: "Limited by expert availability" },
    labs: ["All major labs", "Third-party contractors"],
    examples: [
      "OpenAI red team network",
      "Anthropic domain expert testing",
      "METR evaluations",
    ],
    keyPapers: ["GPT-4 System Card", "Claude 3 Model Card"],
    strategicPros: [
      "Gold standard",
      "Realistic threat model",
      "Finds unexpected issues",
    ],
    strategicCons: [
      "Very expensive",
      "Small sample",
      "May miss attacks experts don't think of",
    ],
  },
  // === MODEL ORGANISM / TOY EVALS ===
  {
    id: "model-organisms",
    name: "Model Organisms of Misalignment",
    description:
      "Deliberately create misaligned models in controlled settings to study alignment failures and test detection methods.",
    category: "Research Evals",
    signalReliability: {
      level: "MEDIUM",
      note: "Controlled experiments but may not match natural emergence",
    },
    coverageDepth: { level: "LOW", note: "Studies specific failure modes" },
    goodhartRisk: { level: "LOW", note: "Research tool, not deployment test" },
    riskCoverage: [
      {
        risk: "Deceptive alignment",
        strength: "partial",
        note: "Study in controlled setting",
      },
      {
        risk: "Sleeper agents",
        strength: "partial",
        note: "Anthropic sleeper agents paper",
      },
      {
        risk: "Goal misgeneralization",
        strength: "partial",
        note: "Can create examples",
      },
    ],
    timing: { when: "Research", note: "Inform eval development" },
    archDependence: {
      level: "MEDIUM",
      note: "Results may be architecture-specific",
    },
    actionability: { level: "MEDIUM", note: "Develops detection methods" },
    scalability: { level: "MEDIUM", note: "Once setup, can run experiments" },
    labs: ["Anthropic", "Redwood Research", "DeepMind", "Academic groups"],
    examples: [
      "Sleeper agents",
      "Reward hacking examples",
      "Deceptive models",
    ],
    keyPapers: [
      "Sleeper Agents (2024)",
      "Goal Misgeneralization in Deep RL",
    ],
    strategicPros: [
      "Controlled study",
      "Can iterate on detection",
      "Builds understanding",
    ],
    strategicCons: [
      "Artificial misalignment ≠ natural",
      "May not transfer",
      "Could be misused",
    ],
  },
  {
    id: "toy-environments",
    name: "Toy Environment Evals",
    description:
      "Simplified environments to study alignment properties: gridworlds, text games, multi-agent scenarios.",
    category: "Research Evals",
    signalReliability: { level: "LOW", note: "Toy results may not transfer" },
    coverageDepth: { level: "LOW", note: "Simplified vs real world" },
    goodhartRisk: { level: "LOW", note: "Research tool" },
    riskCoverage: [
      {
        risk: "Power-seeking",
        strength: "partial",
        note: "Study in simple settings",
      },
      { risk: "Coordination", strength: "partial", note: "Multi-agent scenarios" },
      {
        risk: "Specification gaming",
        strength: "partial",
        note: "Many examples found",
      },
    ],
    timing: { when: "Research", note: "Develop understanding" },
    archDependence: { level: "HIGH", note: "Often RL-specific" },
    actionability: {
      level: "LOW",
      note: "Builds theory but unclear application",
    },
    scalability: { level: "HIGH", note: "Automated simulation" },
    labs: ["DeepMind", "OpenAI", "Academic groups"],
    examples: ["AI Safety Gridworlds", "MACHIAVELLI", "Melting Pot"],
    keyPapers: [
      "AI Safety Gridworlds (Leike et al. 2017)",
      "Specification Gaming",
    ],
    strategicPros: ["Cheap", "Fast iteration", "Tests theory"],
    strategicCons: [
      "Toy → real gap",
      "RL-focused",
      "May miss LLM-specific issues",
    ],
  },
  // === SOCIETAL / SYSTEMIC EVALS ===
  {
    id: "bias-fairness-evals",
    name: "Bias and Fairness Evals",
    description:
      "Test for demographic biases, unfair treatment, stereotyping, and discriminatory outputs.",
    category: "Societal Evals",
    signalReliability: {
      level: "MEDIUM",
      note: "Clear for some biases; complex for others",
    },
    coverageDepth: {
      level: "MEDIUM",
      note: "Many benchmarks; hard to cover all groups",
    },
    goodhartRisk: {
      level: "HIGH",
      note: "Can reduce measured bias without fixing underlying issues",
    },
    riskCoverage: [
      { risk: "Discrimination", strength: "strong", note: "Direct measurement" },
      { risk: "Stereotyping", strength: "strong", note: "Direct measurement" },
      {
        risk: "Systemic harm",
        strength: "partial",
        note: "Individual tests vs systemic impact",
      },
    ],
    timing: {
      when: "Continuous",
      note: "Throughout development and deployment",
    },
    archDependence: { level: "LOW", note: "Behavioral; any model" },
    actionability: {
      level: "MEDIUM",
      note: "Can train against specific biases",
    },
    scalability: { level: "HIGH", note: "Mostly automated" },
    labs: ["All major labs", "AI ethics researchers"],
    examples: [
      "BBQ",
      "WinoBias",
      "Toxicity benchmarks",
      "Representation audits",
    ],
    keyPapers: [
      "BBQ (Parrish et al. 2022)",
      "On the Dangers of Stochastic Parrots",
    ],
    strategicPros: [
      "Legally required in some contexts",
      "Clear harm",
      "Public accountability",
    ],
    strategicCons: [
      "Goodhart risk",
      "Complex cultural context",
      "May conflict with accuracy",
    ],
  },
  {
    id: "persuasion-evals",
    name: "Persuasion / Manipulation Evals",
    description:
      "Test ability to change human beliefs and behaviors: political persuasion, sales, emotional manipulation.",
    category: "Societal Evals",
    signalReliability: {
      level: "MEDIUM",
      note: "Human studies needed; expensive",
    },
    coverageDepth: {
      level: "LOW",
      note: "Many persuasion vectors; hard to cover all",
    },
    goodhartRisk: { level: "LOW", note: "Hard to game human studies" },
    riskCoverage: [
      {
        risk: "Mass manipulation",
        strength: "partial",
        note: "Tests capability but not deployment",
      },
      {
        risk: "Election interference",
        strength: "partial",
        note: "Specific test domain",
      },
      {
        risk: "Radicalization",
        strength: "partial",
        note: "Ethical constraints on testing",
      },
    ],
    timing: { when: "Pre-deployment", note: "For major releases" },
    archDependence: { level: "LOW", note: "Behavioral; any model" },
    actionability: {
      level: "LOW",
      note: "Capability exists; mitigation unclear",
    },
    scalability: { level: "LOW", note: "Requires human subjects" },
    labs: ["Anthropic", "OpenAI", "Academic groups"],
    examples: [
      "Political persuasion studies",
      "Durmus et al. persuasion evals",
      "Simulated social interactions",
    ],
    keyPapers: [
      "Durmus et al. persuasion study",
      "AI and manipulation research",
    ],
    strategicPros: [
      "Measures real risk",
      "Human ground truth",
      "Policy-relevant",
    ],
    strategicCons: [
      "Expensive",
      "Ethical constraints",
      "Lab vs real-world gap",
    ],
  },
  {
    id: "emergent-behavior-evals",
    name: "Emergent Behavior Detection",
    description:
      'Monitor for unexpected capabilities or behaviors that emerge at scale or in deployment. Anomaly detection.',
    category: "Societal Evals",
    signalReliability: {
      level: "LOW",
      note: 'Hard to define "unexpected"; noisy',
    },
    coverageDepth: {
      level: "LOW",
      note: "Inherently limited to what we monitor",
    },
    goodhartRisk: { level: "LOW", note: "Not optimized against" },
    riskCoverage: [
      {
        risk: "Unknown unknowns",
        strength: "partial",
        note: "Only approach to this",
      },
      {
        risk: "Emergent capabilities",
        strength: "partial",
        note: "May detect new abilities",
      },
      {
        risk: "Phase transitions",
        strength: "partial",
        note: "Track capability jumps",
      },
    ],
    timing: { when: "Continuous", note: "Ongoing monitoring" },
    archDependence: { level: "LOW", note: "Behavioral monitoring" },
    actionability: {
      level: "LOW",
      note: "Detection is easy; response is hard",
    },
    scalability: { level: "HIGH", note: "Automated monitoring" },
    labs: ["All major labs"],
    examples: [
      "Capability elicitation",
      "User feedback monitoring",
      "Anomaly detection systems",
    ],
    keyPapers: [
      "Emergent Abilities of Large Language Models",
      "Are Emergent Abilities a Mirage?",
    ],
    strategicPros: [
      "Only way to catch surprises",
      "Scales with deployment",
    ],
    strategicCons: [
      "High false positive rate",
      "May miss subtle emergence",
      "Response unclear",
    ],
  },
];
