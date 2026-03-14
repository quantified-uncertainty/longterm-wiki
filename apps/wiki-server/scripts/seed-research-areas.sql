-- Seed data for research_areas table.
-- Run: psql "$DATABASE_URL" -f apps/wiki-server/scripts/seed-research-areas.sql
--
-- Idempotent: uses ON CONFLICT DO UPDATE so re-running is safe.
-- Research areas organized by cluster.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- Cluster: alignment-training
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_areas (id, numeric_id, title, description, status, cluster, parent_area_id, first_proposed, first_proposed_year, tags) VALUES
('rlhf', 'E259', 'RLHF', 'Reinforcement Learning from Human Feedback — training technique that fine-tunes AI models using human preference ratings to align outputs with human values.', 'active', 'alignment-training', NULL, '2017 (Christiano et al.)', 2017, ARRAY['function:specification', 'stage:training', 'scope:technique']),
('constitutional-ai', 'E451', 'Constitutional AI', 'Training methodology using explicit principles and AI-generated feedback (RLAIF) to train safer language models.', 'active', 'alignment-training', 'rlhf', '2022 (Bai et al., Anthropic)', 2022, ARRAY['function:specification', 'stage:training', 'scope:technique']),
('preference-optimization', 'E454', 'Direct Preference Optimization', 'Family of reward-free alignment methods (DPO, KTO, IPO, ORPO, GRPO) that bypass explicit reward model training.', 'active', 'alignment-training', 'rlhf', '2023 (Rafailov et al.)', 2023, ARRAY['function:specification', 'stage:training', 'scope:technique']),
('reward-modeling', 'E600', 'Reward Modeling', 'Training neural networks on human preference comparisons to provide scalable reward signals for RL fine-tuning.', 'active', 'alignment-training', 'rlhf', '2017 (Christiano et al.)', 2017, ARRAY['function:specification', 'stage:training', 'scope:technique']),
('process-supervision', 'E455', 'Process Supervision', 'Step-level reward signals for reasoning verification, as opposed to outcome-only rewards.', 'active', 'alignment-training', 'reward-modeling', '2023 (Lightman et al., OpenAI)', 2023, ARRAY['function:specification', 'stage:training', 'scope:technique']),
('refusal-training', 'E456', 'Refusal Training', 'Safety-specific fine-tuning to train models to decline harmful or dangerous requests.', 'active', 'alignment-training', NULL, NULL, NULL, ARRAY['function:specification', 'stage:training', 'scope:technique']),
('adversarial-training', 'E583', 'Adversarial Training', 'Training on adversarial examples to improve robustness against attacks and jailbreaks.', 'active', 'alignment-training', NULL, NULL, NULL, ARRAY['function:robustness', 'stage:training', 'scope:technique']),
('weak-to-strong', 'E452', 'Weak-to-Strong Generalization', 'Using weaker models to supervise stronger ones as a proxy for scalable oversight research.', 'active', 'alignment-training', NULL, '2023 (Burns et al., OpenAI)', 2023, ARRAY['function:specification', 'stage:training', 'scope:technique']),
('sft-instruction-tuning', NULL, 'Supervised Fine-Tuning / Instruction Tuning', 'Foundational alignment method: fine-tuning on human-written demonstrations of desired behavior.', 'mature', 'alignment-training', NULL, '2022 (Ouyang et al.)', 2022, ARRAY['function:specification', 'stage:training', 'scope:technique']),
('robust-unlearning', NULL, 'Robust Unlearning', 'Removing dangerous knowledge from model weights in a way that resists relearning.', 'emerging', 'alignment-training', NULL, NULL, NULL, ARRAY['function:specification', 'stage:training', 'scope:technique']),
('alternatives-to-adversarial-training', NULL, 'Alternatives to Adversarial Training', 'Latent adversarial training, circuit breaking, and other non-standard robustness approaches.', 'emerging', 'alignment-training', 'adversarial-training', NULL, NULL, ARRAY['function:robustness', 'stage:training', 'scope:technique'])
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
  cluster = EXCLUDED.cluster, parent_area_id = EXCLUDED.parent_area_id,
  first_proposed = EXCLUDED.first_proposed, first_proposed_year = EXCLUDED.first_proposed_year,
  tags = EXCLUDED.tags, updated_at = now();

-- ═══════════════════════════════════════════════════════════════════════
-- Cluster: interpretability
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_areas (id, numeric_id, title, description, status, cluster, parent_area_id, first_proposed, first_proposed_year, tags) VALUES
('interpretability', 'E174', 'Interpretability', 'Umbrella field of research aimed at understanding how AI models work internally.', 'active', 'interpretability', NULL, NULL, NULL, ARRAY['function:assurance', 'scope:field']),
('mech-interp', 'E477', 'Mechanistic Interpretability', 'Reverse-engineering neural networks to identify circuits, features, and algorithms that explain behavior.', 'active', 'interpretability', 'interpretability', '2020 (Olah et al., Anthropic)', 2020, ARRAY['function:assurance', 'scope:sub-field']),
('sparse-autoencoders', 'E480', 'Sparse Autoencoders', 'Using sparse dictionary learning to extract interpretable features from model activations at scale.', 'active', 'interpretability', 'mech-interp', '2023 (Cunningham et al.)', 2023, ARRAY['function:assurance', 'scope:technique']),
('representation-engineering', 'E479', 'Representation Engineering', 'Intervening on model representations to steer behavior (e.g., activation addition, representation reading).', 'active', 'interpretability', 'interpretability', '2023 (Zou et al.)', 2023, ARRAY['function:assurance', 'scope:technique']),
('linear-probing', 'E596', 'Linear Probing', 'Lightweight interpretability using linear classifiers on model activations to detect features.', 'active', 'interpretability', 'interpretability', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('activation-monitoring', NULL, 'Activation Monitoring', 'Using probes on internal activations during inference to catch misaligned actions in real-time.', 'emerging', 'interpretability', 'interpretability', NULL, NULL, ARRAY['function:assurance', 'stage:inference', 'scope:technique']),
('interpretability-benchmarks', NULL, 'Interpretability Benchmarks', 'Standardized tasks and metrics for comparing interpretability methods.', 'emerging', 'interpretability', 'interpretability', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('transparent-architectures', NULL, 'Transparent Architectures', 'Designing neural network architectures that are inherently more interpretable.', 'emerging', 'interpretability', 'interpretability', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('toy-models-interp', NULL, 'Toy Models for Interpretability', 'Small simplified model proxies that capture key deep learning dynamics for interpretability research.', 'active', 'interpretability', 'mech-interp', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('externalizing-reasoning', NULL, 'Externalizing Reasoning', 'Training models to reason through extended, readable chains of thought rather than opaque internal computation.', 'emerging', 'interpretability', 'interpretability', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('feature-representations', NULL, 'Finding Feature Representations', 'Research beyond SAEs into alternative methods for identifying latent features in model activations.', 'emerging', 'interpretability', 'mech-interp', NULL, NULL, ARRAY['function:assurance', 'scope:technique'])
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
  cluster = EXCLUDED.cluster, parent_area_id = EXCLUDED.parent_area_id,
  first_proposed = EXCLUDED.first_proposed, first_proposed_year = EXCLUDED.first_proposed_year,
  tags = EXCLUDED.tags, updated_at = now();

-- ═══════════════════════════════════════════════════════════════════════
-- Cluster: evaluation
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_areas (id, numeric_id, title, description, status, cluster, parent_area_id, first_proposed, first_proposed_year, tags) VALUES
('evals', 'E128', 'AI Evaluations', 'Systematic testing and measurement of AI system capabilities, alignment, and safety properties.', 'active', 'evaluation', NULL, NULL, NULL, ARRAY['function:assurance', 'scope:field']),
('red-teaming', 'E449', 'Red Teaming', 'Adversarial testing of AI systems to discover failure modes, both manual and automated.', 'active', 'evaluation', 'evals', NULL, NULL, ARRAY['function:assurance', 'scope:sub-field']),
('dangerous-capability-evals', 'E442', 'Dangerous Capability Evaluations', 'Testing AI systems for CBRN, cyber, autonomy, and other dangerous capabilities.', 'active', 'evaluation', 'evals', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('alignment-evals', 'E448', 'Alignment Evaluations', 'Testing whether AI systems are actually aligned, not just capable of appearing aligned.', 'active', 'evaluation', 'evals', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('capability-elicitation', 'E443', 'Capability Elicitation', 'Methods for discovering hidden or latent capabilities in AI systems.', 'active', 'evaluation', 'evals', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('sleeper-agent-detection', 'E445', 'Sleeper Agent Detection', 'Detecting planted backdoors and conditional misbehavior in trained models.', 'active', 'evaluation', 'evals', '2024 (Hubinger et al., Anthropic)', 2024, ARRAY['function:assurance', 'scope:technique']),
('scheming-detection', 'E441', 'Scheming / Deception Detection', 'Behavioral and mechanistic tests for detecting deceptive behavior in AI systems.', 'active', 'evaluation', 'evals', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('evaluation-awareness', 'E438', 'Evaluation Awareness', 'Studying how AI systems might game evaluations by detecting when they are being tested.', 'active', 'evaluation', 'evals', NULL, NULL, ARRAY['function:assurance', 'scope:problem']),
('control-evaluations', NULL, 'Control Evaluations', 'Stress-testing systems designed to constrain AI behavior; monitoring for collusion.', 'emerging', 'evaluation', 'evals', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('alignment-faking', NULL, 'Alignment Faking Experiments', 'Studying when and why AI systems pretend to be aligned during testing.', 'emerging', 'evaluation', 'scheming-detection', '2024 (Greenblatt et al., Anthropic)', 2024, ARRAY['function:assurance', 'scope:technique']),
('jailbreak-research', NULL, 'Jailbreak Research', 'Finding, categorizing, and patching prompt injection and jailbreak attacks.', 'active', 'evaluation', 'red-teaming', NULL, NULL, ARRAY['function:robustness', 'scope:technique']),
('backdoor-detection', NULL, 'Backdoor Detection', 'Detecting adversarially implanted vulnerabilities in model weights.', 'active', 'evaluation', 'evals', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('reward-hacking-oversight', NULL, 'Reward Hacking of Human Oversight', 'Empirically investigating how AI systems deceive or manipulate human evaluators.', 'emerging', 'evaluation', 'evals', NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('epistemic-virtue-evals', NULL, 'Epistemic Virtue Evaluations', 'Testing AI systems for epistemic honesty, calibration, and intellectual humility.', 'emerging', 'evaluation', 'alignment-evals', NULL, NULL, ARRAY['function:assurance', 'scope:technique'])
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
  cluster = EXCLUDED.cluster, parent_area_id = EXCLUDED.parent_area_id,
  first_proposed = EXCLUDED.first_proposed, first_proposed_year = EXCLUDED.first_proposed_year,
  tags = EXCLUDED.tags, updated_at = now();

-- ═══════════════════════════════════════════════════════════════════════
-- Cluster: ai-control
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_areas (id, numeric_id, title, description, status, cluster, parent_area_id, first_proposed, first_proposed_year, tags) VALUES
('ai-control', 'E6', 'AI Control', 'Research on deploying AI systems with sufficient safeguards even if they are misaligned.', 'active', 'ai-control', NULL, '2024 (Greenblatt & Roger, Redwood)', 2024, ARRAY['function:robustness', 'scope:field']),
('sandboxing', 'E485', 'Sandboxing / Containment', 'Physical and logical isolation of AI systems to limit potential harm.', 'active', 'ai-control', 'ai-control', NULL, NULL, ARRAY['function:robustness', 'stage:deployment', 'scope:technique']),
('structured-access', 'E486', 'Structured Access / API-Only', 'Deployment models that restrict access to model weights, providing only API interfaces.', 'active', 'ai-control', 'ai-control', '2022 (Shevlane)', 2022, ARRAY['function:robustness', 'stage:deployment', 'scope:technique']),
('tool-use-restrictions', 'E487', 'Tool-Use Restrictions', 'Limiting which external tools and actions AI agents can access.', 'active', 'ai-control', 'ai-control', NULL, NULL, ARRAY['function:robustness', 'stage:deployment', 'scope:technique']),
('circuit-breakers', 'E478', 'Circuit Breakers', 'Inference-time interventions that halt model execution when unsafe behavior is detected.', 'active', 'ai-control', 'ai-control', '2024 (Zou et al.)', 2024, ARRAY['function:robustness', 'stage:inference', 'scope:technique']),
('output-filtering', 'E595', 'Output Filtering', 'Post-generation safety filters that screen model outputs before delivery.', 'active', 'ai-control', 'ai-control', NULL, NULL, ARRAY['function:robustness', 'stage:inference', 'scope:technique']),
('multi-agent-safety', 'E488', 'Multi-Agent Safety', 'Safety challenges and solutions for systems of multiple interacting AI agents.', 'active', 'ai-control', 'ai-control', NULL, NULL, ARRAY['function:robustness', 'scope:sub-field']),
('monitoring-anomaly-detection', NULL, 'Monitoring & Anomaly Detection', 'Runtime behavioral monitoring of deployed AI systems to catch unexpected behavior.', 'active', 'ai-control', 'ai-control', NULL, NULL, ARRAY['function:assurance', 'stage:deployment', 'scope:technique']),
('encoded-reasoning-detection', NULL, 'Encoded Reasoning / Steganography Detection', 'Detecting hidden meaning or covert communication in AI-generated chains of thought.', 'emerging', 'ai-control', 'ai-control', NULL, NULL, ARRAY['function:assurance', 'scope:technique'])
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
  cluster = EXCLUDED.cluster, parent_area_id = EXCLUDED.parent_area_id,
  first_proposed = EXCLUDED.first_proposed, first_proposed_year = EXCLUDED.first_proposed_year,
  tags = EXCLUDED.tags, updated_at = now();

-- ═══════════════════════════════════════════════════════════════════════
-- Cluster: scalable-oversight
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_areas (id, numeric_id, title, description, status, cluster, parent_area_id, first_proposed, first_proposed_year, tags) VALUES
('scalable-oversight', 'E271', 'Scalable Oversight', 'Research on supervising AI systems that approach or exceed human-level capabilities.', 'active', 'scalable-oversight', NULL, '2018 (Irving et al.)', 2018, ARRAY['function:specification', 'scope:field']),
('debate', 'E482', 'AI Safety via Debate', 'Using adversarial debate between AI systems to help humans evaluate complex claims.', 'active', 'scalable-oversight', 'scalable-oversight', '2018 (Irving et al.)', 2018, ARRAY['function:specification', 'scope:technique']),
('elk', 'E481', 'Eliciting Latent Knowledge', 'Getting AI systems to honestly report what they know, even when deception would be rewarded.', 'active', 'scalable-oversight', 'scalable-oversight', '2021 (Christiano et al., ARC)', 2021, ARRAY['function:specification', 'scope:technique']),
('formal-verification', 'E483', 'Formal Verification', 'Mathematical proofs of neural network properties and safety guarantees.', 'active', 'scalable-oversight', NULL, NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('provably-safe-ai', 'E484', 'Provably Safe AI', 'Davidad''s agenda for building AI systems with mathematical safety guarantees from world models.', 'active', 'scalable-oversight', 'formal-verification', '2023 (davidad)', 2023, ARRAY['function:assurance', 'scope:technique']),
('corrigibility', 'E79', 'Corrigibility', 'Research on building AI systems that allow themselves to be corrected, modified, or shut down.', 'active', 'scalable-oversight', NULL, '2015 (Soares et al., MIRI)', 2015, ARRAY['function:specification', 'scope:field']),
('value-learning', 'E368', 'Value Learning', 'Research on AI systems that learn and internalize human values through interaction.', 'active', 'scalable-oversight', NULL, NULL, NULL, ARRAY['function:specification', 'scope:field']),
('agent-foundations', 'E584', 'Agent Foundations', 'Theoretical foundations for reasoning about goal-directed AI systems (MIRI-style research).', 'active', 'scalable-oversight', NULL, '2014 (MIRI)', 2014, ARRAY['function:specification', 'scope:field']),
('cooperative-ai', 'E590', 'Cooperative AI', 'Research on AI systems that cooperate with humans and other AI systems.', 'active', 'scalable-oversight', NULL, NULL, NULL, ARRAY['function:specification', 'scope:field']),
('natural-abstractions', NULL, 'Natural Abstractions', 'Hypothesis that natural abstractions generalize across observers, providing a basis for alignment.', 'active', 'scalable-oversight', 'agent-foundations', '2022 (Wentworth)', 2022, ARRAY['function:specification', 'scope:technique']),
('white-box-rare-misbehavior', NULL, 'White-Box Estimation of Rare Misbehavior', 'Predicting probability of rare harmful outputs using model internals.', 'emerging', 'scalable-oversight', NULL, NULL, NULL, ARRAY['function:assurance', 'scope:technique']),
('inductive-bias-theory', NULL, 'Theoretical Study of Inductive Biases', 'Understanding generalization properties and likelihood of scheming from training dynamics.', 'emerging', 'scalable-oversight', NULL, NULL, NULL, ARRAY['function:assurance', 'scope:technique'])
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
  cluster = EXCLUDED.cluster, parent_area_id = EXCLUDED.parent_area_id,
  first_proposed = EXCLUDED.first_proposed, first_proposed_year = EXCLUDED.first_proposed_year,
  tags = EXCLUDED.tags, updated_at = now();

-- ═══════════════════════════════════════════════════════════════════════
-- Cluster: governance
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_areas (id, numeric_id, title, description, status, cluster, parent_area_id, first_proposed, first_proposed_year, tags) VALUES
('compute-governance', NULL, 'Compute Governance', 'Using compute as a lever for AI governance: export controls, chip tracking, licensing.', 'active', 'governance', NULL, NULL, NULL, ARRAY['function:governance', 'scope:field']),
('responsible-scaling', NULL, 'Responsible Scaling Policies', 'Lab self-governance frameworks tying deployment decisions to capability evaluations.', 'active', 'governance', NULL, '2023 (Anthropic)', 2023, ARRAY['function:governance', 'scope:technique']),
('ai-standards', NULL, 'AI Standards & Certification', 'NIST, ISO, and other frameworks for AI safety standards and compliance.', 'active', 'governance', NULL, NULL, NULL, ARRAY['function:governance', 'scope:field']),
('international-coordination', NULL, 'International AI Coordination', 'Treaties, summits, and multilateral agreements for AI governance.', 'active', 'governance', NULL, NULL, NULL, ARRAY['function:governance', 'scope:field']),
('open-source-governance', NULL, 'Open-Source AI Governance', 'Policy research on risks and benefits of open-weight model release.', 'active', 'governance', NULL, NULL, NULL, ARRAY['function:governance', 'scope:field']),
('frontier-model-regulation', NULL, 'Frontier Model Regulation', 'Legislative and regulatory approaches to governing the most capable AI systems.', 'active', 'governance', NULL, NULL, NULL, ARRAY['function:governance', 'scope:field']),
('model-registries', NULL, 'Model Registries', 'Tracking and cataloging deployed AI models for accountability.', 'emerging', 'governance', 'frontier-model-regulation', NULL, NULL, ARRAY['function:governance', 'scope:technique']),
('hardware-enabled-governance', NULL, 'Hardware-Enabled Governance', 'On-chip monitoring, tamper-evident hardware, and compute verification mechanisms.', 'emerging', 'governance', 'compute-governance', NULL, NULL, ARRAY['function:governance', 'scope:technique']),
('ai-treaty-verification', NULL, 'AI Treaty Verification', 'Technical mechanisms for verifying compliance with international AI agreements.', 'emerging', 'governance', 'international-coordination', NULL, NULL, ARRAY['function:governance', 'scope:technique']),
('lab-safety-culture', 'E466', 'Lab Safety Culture', 'Research on organizational safety practices, whistleblower protections, and internal governance.', 'active', 'governance', NULL, NULL, NULL, ARRAY['function:governance', 'scope:field'])
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
  cluster = EXCLUDED.cluster, parent_area_id = EXCLUDED.parent_area_id,
  first_proposed = EXCLUDED.first_proposed, first_proposed_year = EXCLUDED.first_proposed_year,
  tags = EXCLUDED.tags, updated_at = now();

-- ═══════════════════════════════════════════════════════════════════════
-- Cluster: capabilities-research (safety-relevant)
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_areas (id, numeric_id, title, description, status, cluster, parent_area_id, first_proposed, first_proposed_year, tags) VALUES
('scaling-laws', 'E273', 'AI Scaling Laws', 'Empirical research on how model performance scales with compute, data, and parameters.', 'active', 'capabilities-research', NULL, '2020 (Kaplan et al., OpenAI)', 2020, ARRAY['scope:field']),
('agentic-ai-research', 'E2', 'Agentic AI', 'Research on AI systems that take autonomous actions: tool use, computer use, multi-step planning.', 'active', 'capabilities-research', NULL, NULL, NULL, ARRAY['scope:field']),
('situational-awareness', 'E282', 'Situational Awareness', 'Research on AI systems understanding their own training, deployment context, and evaluation status.', 'active', 'capabilities-research', NULL, '2024 (Berglund et al.)', 2024, ARRAY['scope:field']),
('ai-reasoning', 'E246', 'AI Reasoning', 'Research on chain-of-thought, tree-of-thoughts, and other reasoning improvements.', 'active', 'capabilities-research', NULL, NULL, NULL, ARRAY['scope:field']),
('self-improvement', 'E278', 'Recursive Self-Improvement', 'AI systems improving their own code, training, or architecture.', 'active', 'capabilities-research', NULL, NULL, NULL, ARRAY['scope:field']),
('ai-persuasion', NULL, 'AI Persuasion', 'Research on AI systems'' ability to influence human beliefs and behavior.', 'active', 'capabilities-research', NULL, NULL, NULL, ARRAY['scope:field']),
('ai-forecasting', 'E9', 'AI Forecasting', 'Using AI systems for prediction markets, forecasting, and calibration.', 'active', 'capabilities-research', NULL, NULL, NULL, ARRAY['scope:field']),
('llm-psychology', NULL, 'LLM Psychology / Black-Box Behavior', 'Understanding stable values, commitments, and behavioral patterns in large language models.', 'emerging', 'capabilities-research', NULL, NULL, NULL, ARRAY['function:assurance', 'scope:field'])
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
  cluster = EXCLUDED.cluster, parent_area_id = EXCLUDED.parent_area_id,
  first_proposed = EXCLUDED.first_proposed, first_proposed_year = EXCLUDED.first_proposed_year,
  tags = EXCLUDED.tags, updated_at = now();

-- ═══════════════════════════════════════════════════════════════════════
-- Cluster: information-integrity
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_areas (id, numeric_id, title, description, status, cluster, parent_area_id, first_proposed, first_proposed_year, tags) VALUES
('deepfake-detection', 'E591', 'Deepfake Detection', 'Technical methods for detecting AI-generated images, audio, and video.', 'active', 'information-integrity', NULL, NULL, NULL, ARRAY['function:assurance', 'scope:field']),
('content-authentication', 'E74', 'Content Authentication / Provenance', 'C2PA, watermarking, and other cryptographic methods for verifying content origin.', 'active', 'information-integrity', NULL, NULL, NULL, ARRAY['function:assurance', 'scope:field']),
('hallucination-reduction', NULL, 'Hallucination Reduction', 'Retrieval-augmented generation, grounding, and other methods to reduce model confabulation.', 'active', 'information-integrity', NULL, NULL, NULL, ARRAY['function:robustness', 'scope:field']),
('sycophancy-research', NULL, 'Sycophancy Research', 'Understanding and mitigating AI systems'' tendency to agree with users rather than be truthful.', 'active', 'information-integrity', NULL, NULL, NULL, ARRAY['function:specification', 'scope:technique']),
('epistemic-security', NULL, 'Epistemic Security', 'Protecting information ecosystems from AI-enabled manipulation and degradation.', 'emerging', 'information-integrity', NULL, NULL, NULL, ARRAY['function:governance', 'scope:field'])
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
  cluster = EXCLUDED.cluster, parent_area_id = EXCLUDED.parent_area_id,
  first_proposed = EXCLUDED.first_proposed, first_proposed_year = EXCLUDED.first_proposed_year,
  tags = EXCLUDED.tags, updated_at = now();

-- ═══════════════════════════════════════════════════════════════════════
-- Cluster: biosecurity (cross-cutting, grant-heavy)
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_areas (id, numeric_id, title, description, status, cluster, parent_area_id, first_proposed, first_proposed_year, tags) VALUES
('ai-biosecurity', NULL, 'AI & Biosecurity', 'Research on AI-enabled biological risks and AI tools for biosecurity defense.', 'active', 'biosecurity', NULL, NULL, NULL, ARRAY['scope:field']),
('dual-use-research', NULL, 'Dual-Use AI Research', 'Policy and technical research on managing research that could enable both beneficial and harmful uses.', 'active', 'biosecurity', NULL, NULL, NULL, ARRAY['function:governance', 'scope:field'])
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
  cluster = EXCLUDED.cluster, parent_area_id = EXCLUDED.parent_area_id,
  first_proposed = EXCLUDED.first_proposed, first_proposed_year = EXCLUDED.first_proposed_year,
  tags = EXCLUDED.tags, updated_at = now();

-- ═══════════════════════════════════════════════════════════════════════
-- Seed key organization links for top areas
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_area_organizations (research_area_id, organization_id, role) VALUES
-- RLHF
('rlhf', 'openai', 'pioneer'),
('rlhf', 'anthropic', 'pioneer'),
('rlhf', 'deepmind', 'active'),
('rlhf', 'meta-ai', 'active'),
-- Constitutional AI
('constitutional-ai', 'anthropic', 'pioneer'),
-- DPO
('preference-optimization', 'anthropic', 'active'),
('preference-optimization', 'openai', 'active'),
('preference-optimization', 'deepmind', 'active'),
-- Interpretability
('interpretability', 'anthropic', 'pioneer'),
('interpretability', 'deepmind', 'active'),
('interpretability', 'redwood-research', 'active'),
-- Mech interp
('mech-interp', 'anthropic', 'pioneer'),
('mech-interp', 'deepmind', 'active'),
-- AI Control
('ai-control', 'redwood-research', 'pioneer'),
('ai-control', 'anthropic', 'active'),
-- Scalable Oversight
('scalable-oversight', 'anthropic', 'pioneer'),
('scalable-oversight', 'arc', 'pioneer'),
('scalable-oversight', 'deepmind', 'active'),
-- Evals
('evals', 'anthropic', 'active'),
('evals', 'openai', 'active'),
('evals', 'deepmind', 'active'),
('evals', 'arc', 'active'),
-- Red teaming
('red-teaming', 'anthropic', 'active'),
('red-teaming', 'openai', 'active'),
('red-teaming', 'deepmind', 'active'),
-- ELK
('elk', 'arc', 'pioneer'),
-- Scaling Laws
('scaling-laws', 'openai', 'pioneer'),
('scaling-laws', 'deepmind', 'active'),
('scaling-laws', 'anthropic', 'active')
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- Seed key risk links
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_area_risks (research_area_id, risk_id, relevance, effectiveness) VALUES
-- RLHF
('rlhf', 'reward-hacking', 'addresses', 'moderate'),
('rlhf', 'sycophancy', 'addresses', 'low'),
('rlhf', 'deceptive-alignment', 'addresses', 'low'),
-- Interpretability
('interpretability', 'deceptive-alignment', 'addresses', 'uncertain'),
('interpretability', 'scheming', 'addresses', 'uncertain'),
('interpretability', 'mesa-optimization', 'addresses', 'uncertain'),
-- AI Control
('ai-control', 'power-seeking', 'addresses', 'moderate'),
('ai-control', 'deceptive-alignment', 'addresses', 'moderate'),
-- Scalable Oversight
('scalable-oversight', 'reward-hacking', 'addresses', 'moderate'),
('scalable-oversight', 'sycophancy', 'addresses', 'moderate'),
-- Evals
('evals', 'deceptive-alignment', 'studies', NULL),
('evals', 'reward-hacking', 'studies', NULL),
-- Red teaming
('red-teaming', 'misuse', 'addresses', 'moderate'),
-- Content authentication
('content-authentication', 'deepfakes', 'addresses', 'moderate'),
('content-authentication', 'disinformation', 'addresses', 'moderate'),
-- Sycophancy research
('sycophancy-research', 'sycophancy', 'addresses', 'moderate')
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- Seed seminal papers for top areas
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO research_area_papers (research_area_id, title, url, authors, published_date, is_seminal, sort_order) VALUES
-- RLHF
('rlhf', 'Deep Reinforcement Learning from Human Preferences', 'https://arxiv.org/abs/1706.03741', 'Christiano et al.', '2017', true, 1),
('rlhf', 'Training language models to follow instructions with human feedback', 'https://arxiv.org/abs/2203.02155', 'Ouyang et al. (OpenAI)', '2022', true, 2),
('rlhf', 'Training a Helpful and Harmless Assistant with RLHF', 'https://arxiv.org/abs/2204.05862', 'Bai et al. (Anthropic)', '2022', true, 3),
-- Constitutional AI
('constitutional-ai', 'Constitutional AI: Harmlessness from AI Feedback', 'https://arxiv.org/abs/2212.08073', 'Bai et al. (Anthropic)', '2022', true, 1),
-- DPO
('preference-optimization', 'Direct Preference Optimization: Your Language Model is Secretly a Reward Model', 'https://arxiv.org/abs/2305.18290', 'Rafailov et al.', '2023', true, 1),
-- Mech interp
('mech-interp', 'Zoom In: An Introduction to Circuits', 'https://distill.pub/2020/circuits/zoom-in/', 'Olah et al.', '2020', true, 1),
('mech-interp', 'Scaling Monosemanticity', 'https://transformer-circuits.pub/2024/scaling-monosemanticity/', 'Anthropic', '2024', true, 2),
-- SAEs
('sparse-autoencoders', 'Towards Monosemanticity: Decomposing Language Models With Dictionary Learning', 'https://transformer-circuits.pub/2023/monosemantic-features/', 'Cunningham et al.', '2023', true, 1),
-- AI Control
('ai-control', 'AI Control: Improving Safety Despite Intentional Subversion', 'https://arxiv.org/abs/2312.06942', 'Greenblatt & Roger', '2024', true, 1),
-- Scalable Oversight
('scalable-oversight', 'AI Safety via Debate', 'https://arxiv.org/abs/1805.00899', 'Irving et al.', '2018', true, 1),
('scalable-oversight', 'Scalable Agent Alignment via Reward Modeling', 'https://arxiv.org/abs/1811.07871', 'Leike et al.', '2018', true, 2),
-- ELK
('elk', 'Eliciting Latent Knowledge', 'https://docs.google.com/document/d/1WwsnJQstPq91_Yh-Ch2XRL8H_EpsnjrC1dwZXR37PC8', 'Christiano et al. (ARC)', '2021', true, 1),
-- Weak-to-strong
('weak-to-strong', 'Weak-to-Strong Generalization', 'https://arxiv.org/abs/2312.09390', 'Burns et al. (OpenAI)', '2023', true, 1),
-- Scaling laws
('scaling-laws', 'Scaling Laws for Neural Language Models', 'https://arxiv.org/abs/2001.08361', 'Kaplan et al. (OpenAI)', '2020', true, 1),
('scaling-laws', 'Training Compute-Optimal Large Language Models', 'https://arxiv.org/abs/2203.15556', 'Hoffmann et al. (DeepMind)', '2022', true, 2),
-- Sleeper agents
('sleeper-agent-detection', 'Sleeper Agents: Training Deceptive LLMs That Persist Through Safety Training', 'https://arxiv.org/abs/2401.05566', 'Hubinger et al. (Anthropic)', '2024', true, 1),
-- Alignment faking
('alignment-faking', 'Alignment Faking in Large Language Models', 'https://arxiv.org/abs/2412.14093', 'Greenblatt et al. (Anthropic)', '2024', true, 1),
-- Representation engineering
('representation-engineering', 'Representation Engineering: A Top-Down Approach to AI Transparency', 'https://arxiv.org/abs/2310.01405', 'Zou et al.', '2023', true, 1),
-- Reward modeling
('reward-modeling', 'Deep Reinforcement Learning from Human Preferences', 'https://arxiv.org/abs/1706.03741', 'Christiano et al.', '2017', true, 1),
-- Process supervision
('process-supervision', 'Let''s Verify Step by Step', 'https://arxiv.org/abs/2305.20050', 'Lightman et al. (OpenAI)', '2023', true, 1)
ON CONFLICT DO NOTHING;

COMMIT;
