/**
 * Research Area Matcher — Tags grants with relevant research areas.
 *
 * Runs as a secondary categorization after the program-matcher.
 * A single grant can match multiple research areas (many-to-many).
 *
 * Uses keyword patterns in grant name/description to identify research areas.
 * Returns an array of { researchAreaId, confidence } for each grant.
 */

export interface ResearchAreaMatch {
  researchAreaId: string;
  confidence: number; // 0-1
}

interface MatchRule {
  areaId: string;
  patterns: RegExp[];
  /** If true, only match on name (not description). Prevents false positives. */
  nameOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Pattern rules — ordered by specificity (more specific first)
// ---------------------------------------------------------------------------

const RULES: MatchRule[] = [
  // ── Alignment Training ──────────────────────────────────────────────
  {
    areaId: "rlhf",
    patterns: [/\brlhf\b/i, /reinforcement learning from human feedback/i, /human feedback/i],
  },
  {
    areaId: "constitutional-ai",
    patterns: [/constitutional ai/i, /\brlaif\b/i, /ai feedback/i],
  },
  {
    areaId: "preference-optimization",
    patterns: [/\bdpo\b/i, /direct preference/i, /preference optim/i, /\bgrpo\b/i, /\bkto\b/i],
  },
  {
    areaId: "reward-modeling",
    patterns: [/reward model/i, /reward hack/i, /reward learn/i],
  },
  {
    areaId: "process-supervision",
    patterns: [/process supervision/i, /process reward/i, /step.level reward/i, /\bprm\b/i],
  },
  {
    areaId: "refusal-training",
    patterns: [/refusal train/i, /safety train/i, /harmlessness train/i],
  },
  {
    areaId: "adversarial-training",
    patterns: [/adversarial train/i, /adversarial robust/i, /adversarial machine learning/i],
  },
  {
    areaId: "weak-to-strong",
    patterns: [/weak.to.strong/i, /superalignment/i],
  },
  {
    areaId: "robust-unlearning",
    patterns: [/unlearn/i, /machine unlearn/i, /knowledge remov/i],
  },

  // ── Interpretability ────────────────────────────────────────────────
  {
    areaId: "mech-interp",
    patterns: [/mechanistic interp/i, /circuit.*(finding|discovery|analysis)/i, /\bmech.interp\b/i],
  },
  {
    areaId: "sparse-autoencoders",
    patterns: [/sparse autoencoder/i, /\bsae\b/i, /dictionary learning/i],
  },
  {
    areaId: "representation-engineering",
    patterns: [/representation engineer/i, /activation (addition|steer)/i, /activation engineer/i],
  },
  {
    areaId: "activation-monitoring",
    patterns: [/activation monitor/i, /activation probe/i, /internal monitor/i],
  },
  {
    areaId: "interpretability",
    patterns: [/interpretab/i, /transparency/i, /white.box/i, /model.*(internal|understand)/i],
  },
  {
    areaId: "externalizing-reasoning",
    patterns: [/externaliz.*reason/i, /faithful.*(chain|cot)/i],
  },
  {
    areaId: "transparent-architectures",
    patterns: [/transparent architect/i, /interpretable.*(architect|design)/i],
  },

  // ── Evaluation ──────────────────────────────────────────────────────
  {
    areaId: "red-teaming",
    patterns: [/red.team/i, /adversarial test/i, /adversarial evaluat/i],
  },
  {
    areaId: "dangerous-capability-evals",
    patterns: [/dangerous capabilit/i, /\bcbrn\b/i, /biosafety eval/i, /capability eval/i],
  },
  {
    areaId: "alignment-evals",
    patterns: [/alignment eval/i, /safety eval/i],
  },
  {
    areaId: "sleeper-agent-detection",
    patterns: [/sleeper agent/i, /backdoor/i, /trojan/i],
  },
  {
    areaId: "scheming-detection",
    patterns: [/scheming/i, /deceptive alignment/i, /deception detect/i],
  },
  {
    areaId: "alignment-faking",
    patterns: [/alignment fak/i, /faking alignment/i],
  },
  {
    areaId: "jailbreak-research",
    patterns: [/jailbreak/i, /prompt injection/i],
  },
  {
    areaId: "evals",
    patterns: [/\beval(uation)?s?\b/i, /benchmark/i, /safety (test|assess)/i],
  },

  // ── AI Control ──────────────────────────────────────────────────────
  {
    areaId: "ai-control",
    patterns: [/\bai control\b/i, /control.*misalign/i, /untrusted model/i],
  },
  {
    areaId: "sandboxing",
    patterns: [/sandbox/i, /containment/i, /isolation/i],
    nameOnly: true,
  },
  {
    areaId: "multi-agent-safety",
    patterns: [/multi.agent/i, /agent.*(collu|cooperat|coordinat)/i],
  },
  {
    areaId: "monitoring-anomaly-detection",
    patterns: [/anomaly detect/i, /runtime monitor/i, /behavioral monitor/i],
  },
  {
    areaId: "encoded-reasoning-detection",
    patterns: [/steganograph/i, /encoded reason/i, /hidden.*communicat/i],
  },

  // ── Scalable Oversight ──────────────────────────────────────────────
  {
    areaId: "scalable-oversight",
    patterns: [/scalable oversight/i, /recursive reward/i, /iterated amplif/i],
  },
  {
    areaId: "debate",
    patterns: [/\bai.*debate\b/i, /debate.*alignment/i],
    nameOnly: true,
  },
  {
    areaId: "elk",
    patterns: [/eliciting latent knowledge/i, /\belk\b/i],
    nameOnly: true,
  },
  {
    areaId: "formal-verification",
    patterns: [/formal verif/i, /neural network verif/i, /provably safe/i],
  },
  {
    areaId: "corrigibility",
    patterns: [/corrigib/i, /shutdown problem/i],
  },
  {
    areaId: "value-learning",
    patterns: [/value learn/i, /value align/i, /inverse reinforcement/i],
  },
  {
    areaId: "agent-foundations",
    patterns: [/agent foundation/i, /\bmiri\b/i, /decision theory/i],
    nameOnly: true,
  },
  {
    areaId: "cooperative-ai",
    patterns: [/cooperative ai/i, /cooperative.*intellig/i],
  },

  // ── Governance ──────────────────────────────────────────────────────
  {
    areaId: "compute-governance",
    patterns: [/compute govern/i, /chip.*(track|govern)/i, /export control/i],
  },
  {
    areaId: "responsible-scaling",
    patterns: [/responsible scal/i, /\brsp\b/i],
    nameOnly: true,
  },
  {
    areaId: "international-coordination",
    patterns: [/international.*ai.*coord/i, /ai.*treat(y|ies)/i, /ai.*summit/i],
  },
  {
    areaId: "frontier-model-regulation",
    patterns: [/frontier.*regulat/i, /ai (act|regulation|legislation|bill|law)/i],
  },

  // ── Capabilities Research ───────────────────────────────────────────
  {
    areaId: "scaling-laws",
    patterns: [/scaling law/i, /compute.optimal/i, /chinchilla/i],
  },
  {
    areaId: "situational-awareness",
    patterns: [/situational awareness/i, /self.knowledge/i],
  },
  {
    areaId: "ai-forecasting",
    patterns: [/\bai forecast/i, /prediction market/i, /forecast.*benchmark/i],
  },

  // ── Information Integrity ───────────────────────────────────────────
  {
    areaId: "deepfake-detection",
    patterns: [/deepfake/i, /synthetic media detect/i],
  },
  {
    areaId: "content-authentication",
    patterns: [/content authent/i, /\bc2pa\b/i, /watermark/i, /provenance/i],
  },
  {
    areaId: "hallucination-reduction",
    patterns: [/hallucinat/i, /grounding/i, /factual.*(accuracy|correct)/i],
  },
  {
    areaId: "sycophancy-research",
    patterns: [/sycophancy/i, /sycophant/i],
  },

  // ── Biosecurity ─────────────────────────────────────────────────────
  {
    areaId: "ai-biosecurity",
    patterns: [/biosecur/i, /bioweapon/i, /biological.*risk/i, /pandemic.*prep/i],
  },
  {
    areaId: "dual-use-research",
    patterns: [/dual.use/i],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GrantInput {
  name: string;
  description?: string | null;
  focusArea?: string | null;
}

/**
 * Match a grant to research areas based on its name and description.
 * Returns all matching areas with confidence scores.
 */
export function matchResearchAreas(grant: GrantInput): ResearchAreaMatch[] {
  const matches: ResearchAreaMatch[] = [];
  const searchName = grant.name ?? "";
  const searchDesc = grant.description ?? "";
  const searchFocus = grant.focusArea ?? "";

  for (const rule of RULES) {
    let matched = false;
    let confidence = 0;

    for (const pattern of rule.patterns) {
      if (pattern.test(searchName)) {
        matched = true;
        confidence = Math.max(confidence, 0.9); // Name match = high confidence
      } else if (!rule.nameOnly) {
        if (pattern.test(searchDesc)) {
          matched = true;
          confidence = Math.max(confidence, 0.6); // Description match = moderate
        }
        if (pattern.test(searchFocus)) {
          matched = true;
          confidence = Math.max(confidence, 0.7); // Focus area match = moderate-high
        }
      }
    }

    if (matched) {
      matches.push({ researchAreaId: rule.areaId, confidence });
    }
  }

  return matches;
}
