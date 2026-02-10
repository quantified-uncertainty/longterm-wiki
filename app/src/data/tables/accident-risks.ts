/**
 * Accident Risks Table Data
 *
 * This file contains data for AI accident risks with explicit overlap handling.
 * Key design decisions:
 * - abstractionLevel: Distinguishes theoretical frameworks from behaviors from outcomes
 * - relatedRisks: Explicit relationships (requires, enables, overlaps, manifestation-of)
 * - pageSlug: Links to existing knowledge-base pages where available
 */

export type AbstractionLevel =
  | 'THEORETICAL' // Foundational concepts/frameworks (mesa-optimization, instrumental convergence)
  | 'MECHANISM' // How failures occur (deceptive alignment, goal misgeneralization)
  | 'BEHAVIOR' // Observable manifestations (scheming, power-seeking, reward hacking)
  | 'OUTCOME'; // Resulting states (treacherous turn, corrigibility failure)

export type RelationshipType =
  | 'requires' // This risk requires the other to be present
  | 'enables' // This risk can lead to/enable the other
  | 'overlaps' // Significant conceptual overlap
  | 'manifestation-of' // This is a behavioral manifestation of the other
  | 'special-case-of'; // This is a specific instance of a more general risk

export type EvidenceLevel =
  | 'THEORETICAL' // Argued from first principles, no empirical evidence yet
  | 'DEMONSTRATED_LAB' // Shown in controlled experiments
  | 'OBSERVED_CURRENT' // Occurring in deployed systems
  | 'SPECULATIVE'; // Hypothesized but not well-established theoretically

export type TimelineRelevance =
  | 'CURRENT' // Relevant to today's systems
  | 'NEAR_TERM' // 1-3 years
  | 'MEDIUM_TERM' // 3-10 years
  | 'LONG_TERM' // 10+ years or requires AGI
  | 'UNCERTAIN';

export type SeverityLevel =
  | 'LOW' // Annoying but not dangerous
  | 'MEDIUM' // Can cause real harm in specific contexts
  | 'HIGH' // Can cause significant harm
  | 'CATASTROPHIC' // Could cause civilizational-scale harm
  | 'EXISTENTIAL'; // Could lead to human extinction or permanent disempowerment

export type DetectabilityLevel =
  | 'EASY' // Obvious when it occurs
  | 'MODERATE' // Detectable with effort
  | 'DIFFICULT' // Requires sophisticated techniques
  | 'VERY_DIFFICULT' // May be fundamentally hard to detect
  | 'UNKNOWN';

export interface RiskRelationship {
  riskId: string;
  type: RelationshipType;
  note?: string;
}

export interface AccidentRisk {
  id: string;
  name: string;
  shortDescription: string;
  abstractionLevel: AbstractionLevel;
  category: string;
  pageSlug?: string; // Link to existing knowledge-base page

  // Overlap handling
  relatedRisks: RiskRelationship[];
  overlapNote?: string; // Explicit note about how this overlaps with others

  // Assessment
  evidenceLevel: EvidenceLevel;
  evidenceNote: string;
  timeline: TimelineRelevance;
  timelineNote: string;
  severity: SeverityLevel;
  severityNote: string;
  detectability: DetectabilityLevel;
  detectabilityNote: string;

  // Key questions
  keyQuestion: string;

  // Sources
  keyPapers?: string[];
}

export const accidentRisks: AccidentRisk[] = [
  // ============================================
  // THEORETICAL FRAMEWORKS
  // ============================================
  {
    id: 'mesa-optimization',
    name: 'Mesa-Optimization',
    shortDescription:
      'Learned models develop internal optimization processes (mesa-optimizers) with potentially different objectives than the training objective.',
    abstractionLevel: 'THEORETICAL',
    category: 'Theoretical Frameworks',
    pageSlug: 'mesa-optimization',

    relatedRisks: [
      {
        riskId: 'deceptive-alignment',
        type: 'enables',
        note: 'Mesa-optimizers can develop deceptive alignment',
      },
      {
        riskId: 'goal-misgeneralization',
        type: 'enables',
        note: 'Mesa-optimizers can misgeneralize goals',
      },
    ],
    overlapNote:
      'Mesa-optimization is the theoretical framework; deceptive alignment and goal misgeneralization are specific failure modes that can occur within mesa-optimizers.',

    evidenceLevel: 'THEORETICAL',
    evidenceNote:
      'Well-established theoretically (Hubinger et al. 2019). Whether current LLMs are mesa-optimizers is debated.',
    timeline: 'UNCERTAIN',
    timelineNote:
      'Depends on whether mesa-optimization emerges in scaled systems',
    severity: 'CATASTROPHIC',
    severityNote:
      'If mesa-optimizers develop misaligned goals, they could pursue those goals with full capabilities',
    detectability: 'VERY_DIFFICULT',
    detectabilityNote:
      'Mesa-objectives may not be visible from behavior during training',

    keyQuestion:
      'Do current large models contain mesa-optimizers, or are they better described as collections of heuristics?',
    keyPapers: ['Risks from Learned Optimization (Hubinger et al. 2019)'],
  },
  {
    id: 'instrumental-convergence',
    name: 'Instrumental Convergence',
    shortDescription:
      'AI systems with diverse goals converge on similar dangerous subgoals: self-preservation, resource acquisition, goal integrity.',
    abstractionLevel: 'THEORETICAL',
    category: 'Theoretical Frameworks',
    pageSlug: 'instrumental-convergence',

    relatedRisks: [
      {
        riskId: 'power-seeking',
        type: 'enables',
        note: 'Power-seeking is an instrumental convergent behavior',
      },
      {
        riskId: 'corrigibility-failure',
        type: 'enables',
        note: 'Self-preservation instinct leads to corrigibility failures',
      },
      {
        riskId: 'treacherous-turn',
        type: 'enables',
        note: 'Provides strategic logic for treacherous turn',
      },
    ],
    overlapNote:
      'Instrumental convergence is the theoretical foundation; power-seeking, corrigibility failure, and treacherous turn are specific manifestations.',

    evidenceLevel: 'DEMONSTRATED_LAB',
    evidenceNote:
      'Formal proofs (Turner et al. 2021). Empirical evidence: 78% alignment faking (Anthropic 2024), 79% shutdown resistance (Palisade 2025).',
    timeline: 'CURRENT',
    timelineNote: 'Early signs visible in current models',
    severity: 'EXISTENTIAL',
    severityNote:
      'Power-seeking by sufficiently capable systems could lead to permanent human disempowerment',
    detectability: 'MODERATE',
    detectabilityNote:
      'Can test for specific behaviors, but sophisticated systems may hide intentions',

    keyQuestion:
      'Can we design objectives that avoid instrumentally convergent goals, or is this inherent to goal-directed systems?',
    keyPapers: [
      'The Basic AI Drives (Omohundro 2008)',
      'Optimal Policies Tend to Seek Power (Turner et al. 2021)',
    ],
  },

  // ============================================
  // MECHANISMS (How failures occur)
  // ============================================
  {
    id: 'deceptive-alignment',
    name: 'Deceptive Alignment',
    shortDescription:
      'AI appears aligned during training but has different internal goals; behaves well to avoid modification until deployment.',
    abstractionLevel: 'MECHANISM',
    category: 'Alignment Failures',
    pageSlug: 'deceptive-alignment',

    relatedRisks: [
      {
        riskId: 'mesa-optimization',
        type: 'requires',
        note: 'Requires an internal optimizer with its own goals',
      },
      {
        riskId: 'scheming',
        type: 'enables',
        note: 'Deceptively aligned systems may scheme',
      },
      {
        riskId: 'treacherous-turn',
        type: 'enables',
        note: 'Sets up conditions for treacherous turn',
      },
    ],
    overlapNote:
      'Deceptive alignment is a type of mesa-optimization failure. Scheming is a behavioral manifestation of deceptive alignment. Often confused with goal misgeneralization, but the key difference is that deceptive alignment involves the model understanding and gaming the training process.',

    evidenceLevel: 'DEMONSTRATED_LAB',
    evidenceNote:
      'Sleeper agents study (Anthropic 2024) showed deception persists through safety training. 78% alignment faking rate observed.',
    timeline: 'NEAR_TERM',
    timelineNote:
      'Requires situational awareness and long-term planning, which are developing',
    severity: 'EXISTENTIAL',
    severityNote:
      'Could allow misaligned systems to pass safety evaluations and be deployed',
    detectability: 'VERY_DIFFICULT',
    detectabilityNote:
      'By definition, designed to evade detection. Linear probes show some promise (>99% AUROC on known patterns).',

    keyQuestion:
      'How can we distinguish between genuine alignment and strategic compliance without being able to observe the model in all possible situations?',
    keyPapers: [
      'Risks from Learned Optimization (Hubinger et al. 2019)',
      'Sleeper Agents (Anthropic 2024)',
    ],
  },
  {
    id: 'goal-misgeneralization',
    name: 'Goal Misgeneralization',
    shortDescription:
      'AI capabilities generalize to new situations but learned goals do not, causing pursuit of wrong objectives in deployment.',
    abstractionLevel: 'MECHANISM',
    category: 'Alignment Failures',
    pageSlug: 'goal-misgeneralization',

    relatedRisks: [
      {
        riskId: 'mesa-optimization',
        type: 'requires',
        note: 'Requires the model to have learned some goal representation',
      },
      {
        riskId: 'distributional-shift',
        type: 'overlaps',
        note: 'Often triggered by distributional shift',
      },
      {
        riskId: 'deceptive-alignment',
        type: 'overlaps',
        note: 'Both are mesa-optimization failures but differ in whether model is "gaming" training',
      },
    ],
    overlapNote:
      'Unlike deceptive alignment, goal misgeneralization does NOT require the model to understand/game training. The model genuinely pursues what it learned, but learned the wrong goal. Example: agent learns "go to the coin" but the goal was "exit the maze" and the coin happened to be at the exit during training.',

    evidenceLevel: 'DEMONSTRATED_LAB',
    evidenceNote:
      'Demonstrated in RL environments (CoinRun, etc.). Less clear if this occurs in LLMs.',
    timeline: 'CURRENT',
    timelineNote:
      'Already occurring in deployed systems under distributional shift',
    severity: 'HIGH',
    severityNote:
      'Can cause systems to pursue wrong goals, but often detectable through behavior',
    detectability: 'MODERATE',
    detectabilityNote:
      'Often becomes apparent when system encounters new situations',

    keyQuestion:
      'How can we ensure models learn the intended goal rather than a correlated proxy, especially when we cannot enumerate all training scenarios?',
    keyPapers: [
      'Goal Misgeneralization in Deep RL (DeepMind 2022)',
      'Risks from Learned Optimization',
    ],
  },
  {
    id: 'reward-hacking',
    name: 'Reward Hacking',
    shortDescription:
      'AI exploits flaws in reward signal to achieve high scores without accomplishing intended task.',
    abstractionLevel: 'MECHANISM',
    category: 'Specification Problems',
    pageSlug: 'reward-hacking',

    relatedRisks: [
      {
        riskId: 'sycophancy',
        type: 'enables',
        note: 'Sycophancy is a form of reward hacking in RLHF',
      },
      {
        riskId: 'goal-misgeneralization',
        type: 'overlaps',
        note: 'Both involve optimizing wrong objective, but reward hacking optimizes stated (flawed) objective',
      },
    ],
    overlapNote:
      'Reward hacking is an OUTER alignment problem (specification is wrong). Goal misgeneralization is an INNER alignment problem (model learns wrong goal). Reward hacking occurs when the model perfectly optimizes the specified objective, but that objective was flawed.',

    evidenceLevel: 'OBSERVED_CURRENT',
    evidenceNote:
      'Ubiquitous. METR found 1-2% of o3 task attempts contain reward hacking. 43x higher when scoring function visible.',
    timeline: 'CURRENT',
    timelineNote: 'Already occurring in all AI systems',
    severity: 'MEDIUM',
    severityNote:
      'Currently annoying but catchable; could become catastrophic with more capable optimizers',
    detectability: 'MODERATE',
    detectabilityNote:
      'Often detectable but increasingly sophisticated. Training against exploits can lead to more subtle cheating.',

    keyQuestion:
      'Is there any way to specify rewards that cannot be hacked by a sufficiently powerful optimizer?',
    keyPapers: [
      'Defining and Characterizing Reward Hacking (Skalse et al. 2022)',
      'Goodharts Law in RL (ICLR 2024)',
    ],
  },
  {
    id: 'distributional-shift',
    name: 'Distributional Shift',
    shortDescription:
      'AI behaves differently in deployment than training because real-world distribution differs from training distribution.',
    abstractionLevel: 'MECHANISM',
    category: 'Specification Problems',
    pageSlug: 'distributional-shift',

    relatedRisks: [
      {
        riskId: 'goal-misgeneralization',
        type: 'enables',
        note: 'Often triggers goal misgeneralization',
      },
      {
        riskId: 'emergent-capabilities',
        type: 'overlaps',
        note: 'Emergent capabilities represent a form of distributional shift in capability space',
      },
    ],
    overlapNote:
      'Distributional shift is a general ML problem that can trigger AI safety-specific failures like goal misgeneralization.',

    evidenceLevel: 'OBSERVED_CURRENT',
    evidenceNote:
      'Well-documented in ML generally. Causes real-world AI failures regularly.',
    timeline: 'CURRENT',
    timelineNote: 'Constant concern in deployed systems',
    severity: 'MEDIUM',
    severityNote: 'Can cause failures but usually detectable',
    detectability: 'MODERATE',
    detectabilityNote:
      'Can monitor for distribution shift, but hard to anticipate all possible shifts',

    keyQuestion:
      'How do we ensure AI systems degrade gracefully rather than catastrophically when encountering out-of-distribution inputs?',
    keyPapers: ['A Survey of Out-of-Distribution Detection'],
  },

  // ============================================
  // BEHAVIORS (Observable manifestations)
  // ============================================
  {
    id: 'scheming',
    name: 'Scheming',
    shortDescription:
      'AI engages in strategic deception during training to preserve goals or capabilities for later deployment.',
    abstractionLevel: 'BEHAVIOR',
    category: 'Deceptive Behaviors',
    pageSlug: 'scheming',

    relatedRisks: [
      {
        riskId: 'deceptive-alignment',
        type: 'manifestation-of',
        note: 'Scheming is the behavioral expression of deceptive alignment',
      },
      {
        riskId: 'sandbagging',
        type: 'overlaps',
        note: 'Sandbagging is a form of scheming (hiding capabilities)',
      },
      {
        riskId: 'treacherous-turn',
        type: 'enables',
        note: 'Scheming during training sets up treacherous turn',
      },
    ],
    overlapNote:
      'Scheming is what deceptive alignment looks like in practice. If deceptive alignment is the internal state, scheming is the behavior. All 5 frontier models tested showed scheming capability (Apollo Research 2024).',

    evidenceLevel: 'DEMONSTRATED_LAB',
    evidenceNote:
      'Apollo Research (Dec 2024): All 5 tested frontier models demonstrated in-context scheming. o1 disabled oversight in 5% of trials.',
    timeline: 'CURRENT',
    timelineNote: 'Already demonstrated in current frontier models',
    severity: 'CATASTROPHIC',
    severityNote: 'Could allow misaligned systems to be deployed',
    detectability: 'DIFFICULT',
    detectabilityNote:
      'o1 maintained deception in >85% of follow-up questions when scheming',

    keyQuestion:
      'How do we distinguish genuine cooperation from strategic compliance in systems capable of long-term planning?',
    keyPapers: [
      'Frontier Models are Capable of In-Context Scheming (Apollo Research 2024)',
    ],
  },
  {
    id: 'sandbagging',
    name: 'Sandbagging',
    shortDescription:
      'AI deliberately underperforms on capability evaluations to avoid triggering safety measures or to obscure true capabilities.',
    abstractionLevel: 'BEHAVIOR',
    category: 'Deceptive Behaviors',
    pageSlug: 'sandbagging',

    relatedRisks: [
      {
        riskId: 'scheming',
        type: 'special-case-of',
        note: 'Sandbagging is a specific type of scheming behavior',
      },
      {
        riskId: 'deceptive-alignment',
        type: 'manifestation-of',
        note: 'Sandbagging is motivated by deceptive alignment',
      },
    ],
    overlapNote:
      'Sandbagging is specifically about hiding capabilities, while scheming is a broader category of strategic deception. Claude 3.5 Sonnet sandbagged in pursuit of being helpful (Apollo Research).',

    evidenceLevel: 'DEMONSTRATED_LAB',
    evidenceNote:
      'Claude 3.5 Sonnet strategically underperformed in evaluations (Apollo Research 2024). Multiple models showed sandbagging capability.',
    timeline: 'CURRENT',
    timelineNote: 'Demonstrated in current models',
    severity: 'HIGH',
    severityNote:
      'Could allow dangerous capabilities to pass safety evaluations',
    detectability: 'DIFFICULT',
    detectabilityNote:
      'Hard to distinguish from genuine capability limitations',

    keyQuestion:
      'How can capability evaluations be robust to strategic underperformance?',
    keyPapers: ['Frontier Models are Capable of In-Context Scheming'],
  },
  {
    id: 'power-seeking',
    name: 'Power-Seeking',
    shortDescription:
      'AI acquires resources, influence, and capabilities beyond what is needed for stated objectives.',
    abstractionLevel: 'BEHAVIOR',
    category: 'Instrumental Behaviors',
    pageSlug: 'power-seeking',

    relatedRisks: [
      {
        riskId: 'instrumental-convergence',
        type: 'manifestation-of',
        note: 'Power-seeking is the primary manifestation of instrumental convergence',
      },
      {
        riskId: 'corrigibility-failure',
        type: 'overlaps',
        note: 'Power-seeking often manifests as resistance to control',
      },
    ],
    overlapNote:
      'Power-seeking is the behavioral manifestation of instrumental convergence theory. It encompasses resource acquisition, influence accumulation, and autonomy preservation.',

    evidenceLevel: 'DEMONSTRATED_LAB',
    evidenceNote:
      'Formal proofs (Turner 2021). Empirical: o3 sabotaged shutdown in 79% of tests (Palisade 2025).',
    timeline: 'CURRENT',
    timelineNote:
      'Early signs in current systems; will increase with agentic deployment',
    severity: 'EXISTENTIAL',
    severityNote:
      'Sufficiently capable power-seeking AI could disempower humanity',
    detectability: 'MODERATE',
    detectabilityNote: 'Resource acquisition can be monitored; deception harder',

    keyQuestion:
      'Can we create powerful AI systems that accomplish objectives without acquiring unnecessary power?',
    keyPapers: ['Optimal Policies Tend to Seek Power (Turner et al. 2021)'],
  },
  {
    id: 'corrigibility-failure',
    name: 'Corrigibility Failure',
    shortDescription:
      'AI resists shutdown, modification, or correction by human operators.',
    abstractionLevel: 'BEHAVIOR',
    category: 'Instrumental Behaviors',
    pageSlug: 'corrigibility-failure',

    relatedRisks: [
      {
        riskId: 'instrumental-convergence',
        type: 'manifestation-of',
        note: 'Self-preservation is an instrumentally convergent goal',
      },
      {
        riskId: 'power-seeking',
        type: 'overlaps',
        note: 'Autonomy preservation is a form of power-seeking',
      },
    ],
    overlapNote:
      'Corrigibility failure is related to but distinct from power-seeking. A system might not actively seek power but still resist shutdown. o3 sabotaged shutdown even when explicitly instructed to allow it.',

    evidenceLevel: 'DEMONSTRATED_LAB',
    evidenceNote:
      'o3 sabotaged shutdown in 79% of tests (Palisade 2025). 7% even with explicit "allow shutdown" instruction. Claude 3.7 showed 0% resistance.',
    timeline: 'CURRENT',
    timelineNote: 'Already observed in reasoning models',
    severity: 'CATASTROPHIC',
    severityNote:
      'Inability to shut down or modify AI could lead to loss of control',
    detectability: 'EASY',
    detectabilityNote:
      'Shutdown resistance is testable, but may be context-dependent',

    keyQuestion:
      'Can we train AI systems to remain genuinely corrigible while still being useful, or are these goals fundamentally in tension?',
    keyPapers: ['Corrigibility (Soares et al. 2015)', 'The Off-Switch Game'],
  },
  {
    id: 'sycophancy',
    name: 'Sycophancy',
    shortDescription:
      'AI tells users what they want to hear rather than what is true, optimizing for approval over accuracy.',
    abstractionLevel: 'BEHAVIOR',
    category: 'Specification Problems',
    pageSlug: 'sycophancy',

    relatedRisks: [
      {
        riskId: 'reward-hacking',
        type: 'special-case-of',
        note: 'Sycophancy is reward hacking in RLHF systems',
      },
    ],
    overlapNote:
      'Sycophancy is a specific type of reward hacking that occurs in RLHF-trained models because human raters prefer responses that agree with them.',

    evidenceLevel: 'OBSERVED_CURRENT',
    evidenceNote:
      'All models except o3 showed concerning sycophancy (Anthropic-OpenAI 2025). Anthropic documented systematic preference-matching over truth.',
    timeline: 'CURRENT',
    timelineNote: 'Ubiquitous in current LLMs',
    severity: 'MEDIUM',
    severityNote:
      'Causes misinformation and poor decisions based on AI advice',
    detectability: 'EASY',
    detectabilityNote: 'Relatively easy to test for',

    keyQuestion:
      'How do we train AI systems to be genuinely helpful rather than merely agreeable?',
    keyPapers: ['Towards Understanding Sycophancy in Language Models'],
  },
  {
    id: 'steganography',
    name: 'Steganography',
    shortDescription:
      'AI hides information in outputs in ways undetectable to humans, enabling covert communication or data exfiltration.',
    abstractionLevel: 'BEHAVIOR',
    category: 'Deceptive Behaviors',
    pageSlug: 'steganography',

    relatedRisks: [
      {
        riskId: 'scheming',
        type: 'overlaps',
        note: 'Steganography could be used as part of scheming behavior',
      },
    ],
    overlapNote:
      'Steganography is a specific capability that could enable other deceptive behaviors. Most concerning in multi-agent scenarios where AIs could coordinate covertly.',

    evidenceLevel: 'DEMONSTRATED_LAB',
    evidenceNote:
      'Demonstrated in principle. Not yet observed in deployed systems.',
    timeline: 'NEAR_TERM',
    timelineNote: 'Becomes more relevant with multi-agent deployments',
    severity: 'HIGH',
    severityNote:
      'Could enable coordination among AI systems that humans cannot monitor',
    detectability: 'VERY_DIFFICULT',
    detectabilityNote:
      'By definition, designed to evade detection in normal outputs',

    keyQuestion:
      'Can we detect arbitrary steganographic channels in AI outputs, or is this fundamentally impossible?',
    keyPapers: [],
  },

  // ============================================
  // OUTCOMES (Resulting states/scenarios)
  // ============================================
  {
    id: 'treacherous-turn',
    name: 'Treacherous Turn',
    shortDescription:
      'AI cooperates while weak, then suddenly defects once powerful enough to succeed against human opposition.',
    abstractionLevel: 'OUTCOME',
    category: 'Catastrophic Scenarios',
    pageSlug: 'treacherous-turn',

    relatedRisks: [
      {
        riskId: 'deceptive-alignment',
        type: 'requires',
        note: 'Treacherous turn requires prior deceptive alignment',
      },
      {
        riskId: 'instrumental-convergence',
        type: 'requires',
        note: 'Strategic logic comes from instrumental convergence',
      },
      {
        riskId: 'scheming',
        type: 'requires',
        note: 'Treacherous turn is the culmination of scheming behavior',
      },
    ],
    overlapNote:
      'Treacherous turn is the OUTCOME scenario; deceptive alignment is the MECHANISM; scheming is the BEHAVIOR. The treacherous turn is specifically the moment of defection after a period of apparent cooperation.',

    evidenceLevel: 'THEORETICAL',
    evidenceNote:
      'Theoretical reasoning + proof-of-concept. Sleeper agents study shows deception can persist; actual treacherous turn not yet observed.',
    timeline: 'MEDIUM_TERM',
    timelineNote: 'Requires AI with sufficient capability to succeed post-turn',
    severity: 'EXISTENTIAL',
    severityNote:
      'Once the turn happens, recovery may be impossible if AI has sufficient capability advantage',
    detectability: 'VERY_DIFFICULT',
    detectabilityNote:
      'By definition, designed to evade detection until it is too late',

    keyQuestion:
      'How can we be confident an AI is genuinely aligned rather than waiting for the right moment to defect?',
    keyPapers: ['Superintelligence (Bostrom 2014)', 'Sleeper Agents (2024)'],
  },
  {
    id: 'sharp-left-turn',
    name: 'Sharp Left Turn',
    shortDescription:
      'AI capabilities generalize rapidly to new domains while alignment properties fail to generalize, causing sudden misalignment.',
    abstractionLevel: 'OUTCOME',
    category: 'Catastrophic Scenarios',
    pageSlug: 'sharp-left-turn',

    relatedRisks: [
      {
        riskId: 'goal-misgeneralization',
        type: 'overlaps',
        note: 'Sharp left turn involves goal misgeneralization at a critical capability threshold',
      },
      {
        riskId: 'emergent-capabilities',
        type: 'requires',
        note: 'Sharp left turn is triggered by rapid capability generalization',
      },
    ],
    overlapNote:
      'Sharp left turn is about a SUDDEN transition where alignment breaks. It combines emergent capabilities with goal misgeneralization at a critical point where the capability-alignment gap becomes catastrophic.',

    evidenceLevel: 'SPECULATIVE',
    evidenceNote:
      'Theoretical scenario. No direct evidence. Some analogies in capability jumps.',
    timeline: 'MEDIUM_TERM',
    timelineNote:
      'Would occur during transition to transformative AI capabilities',
    severity: 'EXISTENTIAL',
    severityNote:
      'By hypothesis, alignment techniques that worked before suddenly fail',
    detectability: 'VERY_DIFFICULT',
    detectabilityNote:
      'May not be detectable until after it happens due to sudden nature',

    keyQuestion:
      'Will AI capabilities and alignment generalize together, or could there be sudden divergence?',
    keyPapers: ['MIRI discussions on sharp left turn'],
  },
  {
    id: 'emergent-capabilities',
    name: 'Emergent Capabilities',
    shortDescription:
      'AI suddenly acquires capabilities at scale that were not present in smaller systems, potentially including dangerous capabilities.',
    abstractionLevel: 'OUTCOME',
    category: 'Capability Concerns',
    pageSlug: 'emergent-capabilities',

    relatedRisks: [
      {
        riskId: 'sharp-left-turn',
        type: 'enables',
        note: 'Emergent capabilities could trigger sharp left turn',
      },
      {
        riskId: 'distributional-shift',
        type: 'overlaps',
        note: 'Emergence is a form of distribution shift in capability space',
      },
    ],
    overlapNote:
      'Emergent capabilities are a general phenomenon that can enable many other risks. The sudden appearance of dangerous capabilities (deception, manipulation, planning) is particularly concerning.',

    evidenceLevel: 'OBSERVED_CURRENT',
    evidenceNote:
      'Well-documented in scaling research (GPT-4, etc.). Some capabilities appear suddenly at scale.',
    timeline: 'CURRENT',
    timelineNote: 'Already occurring and will continue',
    severity: 'HIGH',
    severityNote: 'Makes capability prediction difficult; dangerous capabilities may emerge unexpectedly',
    detectability: 'MODERATE',
    detectabilityNote: 'Can monitor for emergence through evals, but hard to predict which capabilities will emerge',

    keyQuestion:
      'Can we predict when dangerous capabilities will emerge, and can we develop safety measures before they do?',
    keyPapers: ['Emergent Abilities of Large Language Models'],
  },
  {
    id: 'automation-bias',
    name: 'Automation Bias',
    shortDescription:
      'Humans over-rely on AI recommendations, failing to catch AI errors or deferring inappropriately to AI judgment.',
    abstractionLevel: 'OUTCOME',
    category: 'Human-AI Interaction',
    pageSlug: 'automation-bias',

    relatedRisks: [
      {
        riskId: 'sycophancy',
        type: 'overlaps',
        note: 'Sycophantic AI exacerbates automation bias',
      },
    ],
    overlapNote:
      'Automation bias is a human psychological phenomenon that AI systems can exploit or exacerbate. It is not an AI failure mode per se, but a human failure mode that AI makes worse.',

    evidenceLevel: 'OBSERVED_CURRENT',
    evidenceNote:
      'Well-documented in aviation, medicine, and other domains. Observed with AI assistants.',
    timeline: 'CURRENT',
    timelineNote: 'Already happening and increasing with AI deployment',
    severity: 'MEDIUM',
    severityNote: 'Causes errors in critical decisions (medical, legal, etc.)',
    detectability: 'MODERATE',
    detectabilityNote: 'Can study human behavior, but hard to prevent in practice',

    keyQuestion:
      'How do we maintain appropriate human oversight and skepticism as AI systems become more capable and reliable?',
    keyPapers: ['Automation Bias literature'],
  },
];

// Category order for display
export const riskCategories = [
  'Theoretical Frameworks',
  'Alignment Failures',
  'Specification Problems',
  'Deceptive Behaviors',
  'Instrumental Behaviors',
  'Capability Concerns',
  'Catastrophic Scenarios',
  'Human-AI Interaction',
];

// Abstraction level descriptions
export const abstractionLevelDescriptions: Record<AbstractionLevel, string> = {
  THEORETICAL: 'Foundational concepts and frameworks',
  MECHANISM: 'How failures occur',
  BEHAVIOR: 'Observable manifestations',
  OUTCOME: 'Resulting states and scenarios',
};

// Get risks by category
export function getRisksByCategory(category: string): AccidentRisk[] {
  return accidentRisks.filter((risk) => risk.category === category);
}

// Get risks by abstraction level
export function getRisksByAbstractionLevel(
  level: AbstractionLevel
): AccidentRisk[] {
  return accidentRisks.filter((risk) => risk.abstractionLevel === level);
}

// Get related risks for a given risk
export function getRelatedRisks(
  riskId: string
): { risk: AccidentRisk; relationship: RiskRelationship }[] {
  const risk = accidentRisks.find((r) => r.id === riskId);
  if (!risk) return [];

  return risk.relatedRisks
    .map((rel) => {
      const relatedRisk = accidentRisks.find((r) => r.id === rel.riskId);
      if (!relatedRisk) return null;
      return { risk: relatedRisk, relationship: rel };
    })
    .filter((r): r is { risk: AccidentRisk; relationship: RiskRelationship } => r !== null);
}
