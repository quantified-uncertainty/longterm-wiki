import type { SuggestedPage } from "./suggested-pages-table";

// Priority is 1–100 based on: how often the topic is mentioned across existing
// pages (prose grep + EntityLink count), whether broken links exist, and
// editorial importance to AI-safety coverage. "Mentions" = number of existing
// MDX pages that reference this term in prose or via EntityLink.

export const suggestions: SuggestedPage[] = [
  // --- 91–100: referenced on 80+ pages, fundamental gaps ---
  { title: "AI Governance", type: "concept", priority: 100, mentions: 183, reason: "Mentioned on 183 pages. Sub-topics exist (compute governance, etc.) but no umbrella page." },
  { title: "Reinforcement Learning", type: "concept", priority: 99, mentions: 81, reason: "Mentioned on 81 pages. Underpins RLHF, reward modeling, and alignment methods — no standalone page." },
  { title: "Retrieval-Augmented Generation (RAG)", type: "concept", priority: 98, mentions: 404, reason: "Referenced on 404 pages — most-mentioned concept without a page." },
  { title: "GPT-4", type: "capability", priority: 97, mentions: 193, reason: "Central reference point for frontier capabilities, mentioned on 193 pages." },
  { title: "Claude (Model Family)", type: "capability", priority: 96, mentions: 186, reason: "Anthropic's flagship model, mentioned on 186 pages, no standalone page." },
  { title: "Frontier Model (Concept)", type: "concept", priority: 95, mentions: 161, reason: "The concept of 'frontier model' is used on 161 pages with no definition page." },
  { title: "Training Data", type: "concept", priority: 94, mentions: 111, reason: "Fundamental topic (curation, bias, consent, copyright) — 111 page mentions." },
  { title: "Safety Evaluations", type: "response", priority: 93, mentions: 106, reason: "Referenced on 106 pages; evals are how labs demonstrate safety." },
  { title: "Misalignment Potential", type: "ai-transition-model", priority: 92, mentions: 110, reason: "110 EntityLinks to this transition-model factor, no page exists." },
  { title: "Civilizational Competence", type: "ai-transition-model", priority: 91, mentions: 104, reason: "104 EntityLinks to this transition-model factor, no page exists." },

  // --- 85–94: 40–99 page mentions ---
  { title: "Model Evaluation (Methodology)", type: "response", priority: 90, mentions: 55, reason: "Referenced on 55 pages. Capability evals, dangerous-capability evals, eval science — no methodology page." },
  { title: "Fine-Tuning", type: "concept", priority: 89, mentions: 89, reason: "Key technique for adapting models; safety implications of open fine-tuning." },
  { title: "Gemini (Google DeepMind)", type: "capability", priority: 88, mentions: 88, reason: "Google's frontier model family, mentioned on 88 pages." },
  { title: "Llama (Meta)", type: "capability", priority: 87, mentions: 82, reason: "Most widely used open-weights model. 82 page mentions." },
  { title: "DeepSeek", type: "organization", priority: 86, mentions: 71, reason: "Chinese frontier lab (R1, V3) — changed compute-efficiency assumptions globally." },
  { title: "GPT-5 / Next-Gen OpenAI", type: "capability", priority: 85, mentions: 67, reason: "Frequently referenced as next capability milestone, 67 page mentions." },
  { title: "Transformer Architecture", type: "concept", priority: 84, mentions: 65, reason: "The architecture underlying all frontier models; no explainer page." },
  { title: "Jailbreaking & Prompt Injection", type: "risk", priority: 83, mentions: 81, reason: "Primary attack vector against deployed LLMs. Covers direct jailbreaks + indirect injection in tool-use contexts." },
  { title: "Multimodal AI", type: "capability", priority: 82, mentions: 49, reason: "Vision/audio models have distinct safety challenges. 49 mentions." },
  { title: "Training Runs & Compute Cost", type: "concept", priority: 81, mentions: 47, reason: "Economics of training — cost, duration, environmental impact. 47 mentions." },
  { title: "Foundation Model (Concept)", type: "concept", priority: 80, mentions: 46, reason: "Distinct from 'frontier model' — the general category. 46 mentions." },

  // --- 70–79: 15–39 page mentions, high importance ---
  { title: "Hallucination", type: "risk", priority: 79, mentions: 41, reason: "Most user-visible AI failure mode. 41 mentions, no dedicated page." },
  { title: "AI Chips & Hardware", type: "concept", priority: 78, mentions: 39, reason: "GPU/TPU/custom silicon — hardware is a key governance lever. 39 mentions." },
  { title: "Semiconductor Industry", type: "concept", priority: 77, mentions: 35, reason: "Supply chain chokepoints (TSMC, ASML). 35 mentions." },
  { title: "Grok (xAI)", type: "capability", priority: 76, mentions: 33, reason: "xAI's model. 33 mentions; no entity or page." },
  { title: "Embeddings & Vector Search", type: "concept", priority: 75, mentions: 33, reason: "How models represent knowledge. 33 mentions." },
  { title: "AI Incidents Database", type: "incidents", priority: 74, mentions: 32, reason: "Only 2 incident pages exist. Need a comprehensive tracker." },
  { title: "Benchmarks & Leaderboards", type: "concept", priority: 73, mentions: 28, reason: "How capabilities are measured; gaming and limitations. 28 mentions." },
  { title: "Mistral AI", type: "organization", priority: 72, mentions: 27, reason: "Leading European frontier lab. Important for EU AI Act context." },
  { title: "DPO & RLHF Alternatives", type: "response", priority: 71, mentions: 27, reason: "DPO, IPO, KTO — alternatives to RLHF for alignment. 27 mentions." },
  { title: "Transition Turbulence", type: "ai-transition-model", priority: 70, mentions: 26, reason: "26 EntityLinks to this transition-model factor, no page." },

  // --- 60–69: 15–25 page mentions, significant gaps ---
  { title: "Synthetic Data", type: "concept", priority: 69, mentions: 24, reason: "Self-play and synthetic training data — model collapse risk. 24 mentions." },
  { title: "Model Weights (Security & Access)", type: "concept", priority: 68, mentions: 40, reason: "Referenced on 40 pages. Weight theft, open release decisions, proliferation risk — no standalone page." },
  { title: "Pre-Training", type: "concept", priority: 67, mentions: 21, reason: "The initial training phase. Distinct safety considerations from fine-tuning." },
  { title: "Knowledge Distillation", type: "concept", priority: 66, mentions: 20, reason: "Compressing large models; safety properties may not transfer. 20 mentions." },
  { title: "Post-Training (RLHF, Safety)", type: "concept", priority: 65, mentions: 20, reason: "Where safety alignment happens in practice. 20 mentions." },
  { title: "Content Provenance & C2PA", type: "response", priority: 64, mentions: 19, reason: "Technical countermeasure to deepfakes and AI content. 19 mentions." },
  { title: "Misuse Potential", type: "ai-transition-model", priority: 63, mentions: 18, reason: "18 EntityLinks to this transition-model factor, no page." },
  { title: "AI Watermarking", type: "response", priority: 62, mentions: 18, reason: "SynthID, text watermarks — detection of AI-generated content." },
  { title: "Data Annotation & AI Labor", type: "concept", priority: 61, mentions: 18, reason: "Ghost work, RLHF annotators, labor conditions. 18 mentions." },
  { title: "Intelligence Explosion", type: "concept", priority: 60, mentions: 17, reason: "Core AI safety concept (Good, Bostrom). 17 mentions, no page." },

  // --- 50–59: 5–16 page mentions or broken EntityLinks ---
  { title: "Voice Cloning", type: "risk", priority: 59, mentions: 17, reason: "Fraud, impersonation, consent issues. 17 mentions." },
  { title: "Model Cards & Documentation", type: "response", priority: 58, mentions: 17, reason: "Standard disclosure format for AI models. 17 mentions." },
  { title: "Context Windows", type: "concept", priority: 57, mentions: 17, reason: "Key capability dimension (4k to 1M+) with safety implications." },
  { title: "TSMC", type: "organization", priority: 56, mentions: 16, reason: "Single point of failure for advanced chips. 16 mentions." },
  { title: "Epoch AI", type: "organization", priority: 55, mentions: 16, reason: "16 EntityLinks to this org — key data source for AI trends." },
  { title: "Open Weights", type: "concept", priority: 54, mentions: 16, reason: "Distinct from 'open source' — weights-only release model." },
  { title: "Attention Mechanism", type: "concept", priority: 53, mentions: 14, reason: "Core transformer component. 14 mentions." },
  { title: "Capability Overhang", type: "concept", priority: 52, mentions: 13, reason: "When existing hardware can run much more capable models. 13 mentions." },
  { title: "Test-Time Compute & Reasoning", type: "capability", priority: 51, mentions: 11, reason: "o1/o3/R1 inference-scaling paradigm — changes safety assumptions." },
  { title: "Chinchilla Scaling", type: "concept", priority: 50, mentions: 11, reason: "Compute-optimal training. 11 mentions." },

  // --- 40–49: important structural gaps ---
  { title: "Hugging Face", type: "organization", priority: 49, mentions: 10, reason: "Central hub for open-weights models and datasets." },
  { title: "Knowledge Graphs for AI", type: "concept", priority: 48, mentions: 10, reason: "Structured knowledge + LLMs. 10 mentions." },
  { title: "Alignment Tax", type: "concept", priority: 47, mentions: 9, reason: "Cost of making models safe vs. capable. Key policy concept." },
  { title: "Image & Video Generation", type: "capability", priority: 46, mentions: 16, reason: "Diffusion models, DALL-E, Midjourney, Sora — architecture and safety issues." },
  { title: "AI Auditing", type: "response", priority: 45, mentions: 9, reason: "Third-party safety audits. Emerging profession." },
  { title: "Data Poisoning", type: "risk", priority: 44, mentions: 8, reason: "Supply-chain attack on training data. Distinct from adversarial examples." },
  { title: "Brain Emulation", type: "concept", priority: 43, mentions: 8, reason: "Whole brain emulation as alternative path to AGI. 8 mentions." },
  { title: "Algorithmic Bias", type: "risk", priority: 42, mentions: 6, reason: "6 dangling EntityLinks. Needs entity + page." },
  { title: "Model Collapse", type: "risk", priority: 41, mentions: 7, reason: "Training on AI-generated data degrades quality. Emerging research." },
  { title: "AI Consciousness & Moral Status", type: "concept", priority: 40, mentions: 7, reason: "Sentience, moral patienthood, digital minds. 7 mentions." },

  // --- 30–39: important but less frequently referenced ---
  { title: "AI Technical Standards", type: "response", priority: 39, mentions: 38, reason: "Referenced on 38 pages. ISO, NIST, IEEE frameworks — how standards interact with regulation." },
  { title: "Chain-of-Thought Reasoning", type: "concept", priority: 38, mentions: 6, reason: "Prompting technique that elicits reasoning. Safety implications." },
  { title: "Function Calling & Tool Use", type: "capability", priority: 37, mentions: 6, reason: "Agentic capability — models invoking APIs. Security concerns." },
  { title: "Differential Privacy", type: "response", priority: 36, mentions: 6, reason: "Mathematical privacy guarantees for training data." },
  { title: "Regulatory Arbitrage", type: "risk", priority: 35, mentions: 5, reason: "5 dangling EntityLinks. Companies choosing least-regulated jurisdictions." },
  { title: "AI Liability & Legal Frameworks", type: "response", priority: 34, mentions: 5, reason: "Who pays when AI causes harm? Foundational governance question." },
  { title: "NVIDIA", type: "organization", priority: 33, mentions: 4, reason: "4 dangling EntityLinks. Dominant AI chip supplier." },
  { title: "Compliance Costs", type: "concept", priority: 32, mentions: 4, reason: "4 dangling EntityLinks. Cost of regulation for AI companies." },
  { title: "Chinese AI Ecosystem", type: "concept", priority: 31, mentions: 4, reason: "Baidu, Alibaba, Tencent, ByteDance — different safety norms." },
  { title: "Reward Modeling", type: "response", priority: 30, mentions: 3, reason: "Positive framing of reward specification. Complements reward-hacking page." },

  // --- 20–29: thematic/structural gaps, researchers, orgs ---
  { title: "Model Merging & Weight Manipulation", type: "risk", priority: 29, mentions: 3, reason: "Open-source technique to combine or modify model capabilities." },
  { title: "AI Supply Chain", type: "concept", priority: 28, mentions: 3, reason: "End-to-end: data, compute, training, deployment. Chokepoints." },
  { title: "Post-Deployment Monitoring", type: "response", priority: 27, mentions: 2, reason: "Runtime safety monitoring. Most safety work is pre-deployment." },
  { title: "Federated Learning", type: "concept", priority: 26, mentions: 2, reason: "Privacy-preserving training across distributed data." },
  { title: "AI Energy & Environmental Impact", type: "concept", priority: 25, mentions: 2, reason: "Data center power, water use, carbon footprint of training." },
  { title: "Compute Governance Tracking", type: "metric", priority: 24, mentions: 2, reason: "Are compute thresholds actually enforced? No tracking page." },
  { title: "Foundation Model Commoditization", type: "model", priority: 23, mentions: 2, reason: "Pricing collapse changes lab safety incentives." },
  { title: "In-Context Learning", type: "concept", priority: 22, mentions: 2, reason: "How LLMs learn from prompts. Safety implications for elicitation." },
  { title: "AI-Enabled Scientific Fraud", type: "risk", priority: 21, mentions: 2, reason: "Paper mills, fabricated data, fake peer reviews." },
  { title: "Speculative Decoding", type: "concept", priority: 20, mentions: 1, reason: "Inference optimization affecting deployment safety properties." },

  // --- 15–19: notable researchers without pages ---
  { title: "Shane Legg", type: "researcher", priority: 19, mentions: 0, reason: "DeepMind co-founder. Entity exists, no page." },
  { title: "Nate Soares", type: "researcher", priority: 18, mentions: 0, reason: "MIRI Executive Director. Entity exists, no page." },
  { title: "Beth Barnes", type: "researcher", priority: 17, mentions: 0, reason: "Founded METR (Model Evaluation & Threat Research). Entity exists, no page." },
  { title: "Gary Marcus", type: "researcher", priority: 16, mentions: 0, reason: "Prominent AI critic and public commentator. Entity exists, no page." },
  { title: "Ian Hogarth", type: "researcher", priority: 15, mentions: 0, reason: "Chair of UK AI Safety Institute. Entity exists, no page." },

  // --- 10–14: researcher + org gaps ---
  { title: "Buck Shlegeris", type: "researcher", priority: 14, mentions: 0, reason: "CEO of Redwood Research. Entity exists, no page." },
  { title: "Elizabeth Kelly", type: "researcher", priority: 13, mentions: 0, reason: "Director of US AI Safety Institute. Entity exists, no page." },
  { title: "ARC Evaluations", type: "organization", priority: 12, mentions: 0, reason: "Entity exists (arc-evals), no page. Key eval org." },
  { title: "Redwood Research", type: "organization", priority: 11, mentions: 0, reason: "Entity 'redwood' exists separately from redwood-research page — may need merge or separate page." },
  { title: "Homomorphic Encryption for AI", type: "concept", priority: 10, mentions: 1, reason: "Privacy-preserving inference. Niche but growing." },

  // --- 5–9: additional structural gaps ---
  { title: "Tokenization", type: "concept", priority: 9, mentions: 3, reason: "How text becomes model input. Affects multilingual safety." },
  { title: "Deepfake Detection", type: "response", priority: 8, mentions: 3, reason: "Technical countermeasure to deepfakes. Detection arms race." },
  { title: "AI Copyright & Fair Use", type: "concept", priority: 7, mentions: 3, reason: "Training data rights, output ownership. Active litigation." },
  { title: "Catastrophic Forgetting", type: "concept", priority: 6, mentions: 2, reason: "Models lose capabilities during fine-tuning. Safety implications." },
  { title: "Mixture of Experts", type: "concept", priority: 5, mentions: 2, reason: "Architecture used by GPT-4, Mixtral. Efficiency vs. safety." },

  // --- 1–4: lower priority but worth tracking ---
  { title: "AI Labor Displacement (Empirical)", type: "metric", priority: 4, mentions: 1, reason: "Tracking actual job impacts as of 2026." },
  { title: "Red-Teaming-as-a-Service", type: "response", priority: 3, mentions: 1, reason: "Commercial red-teaming offerings and effectiveness." },
  { title: "Continual Learning", type: "concept", priority: 2, mentions: 1, reason: "Models that learn after deployment. Safety of ongoing adaptation." },
  { title: "AI Military & Intelligence Applications", type: "concept", priority: 1, mentions: 1, reason: "Beyond autonomous weapons — broader military AI use." },
];
