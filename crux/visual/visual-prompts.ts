/**
 * Visual Pipeline - Style Guide Prompts
 *
 * Detailed prompts for each visual type, encoding the project's
 * style conventions and quality standards.
 */

export const MERMAID_STYLE_GUIDE = `
## Mermaid Diagram Style Guide

### Layout Rules
- Prefer \`flowchart TD\` (top-down) over \`LR\` (left-right) — narrow content areas compress wide diagrams
- Max 3-4 parallel nodes per row
- Max 15-20 nodes total (if more content, use a table instead)
- Use subgraphs for vertical sections instead of deep horizontal trees
- Use subgraph ID["Label"] syntax (not old-style subgraph "Label")

### Color Palette
- Risk/negative: fill:#ffcccc (light red), fill:#ffddcc (orange), fill:#ffeedd (peach)
- Positive/safe: fill:#ccffcc (light green)
- Neutral/info: fill:#cceeff (light blue), fill:#fff4e1 (yellow), fill:#e1f5ff (pale blue)

### Diagram Type Selection
| Use Case            | Type              | Notes                        |
|---------------------|-------------------|------------------------------|
| Process flow        | flowchart TD      | Decision trees, pipelines    |
| Causal relationships| flowchart + labels| Influence diagrams           |
| Proportions         | pie               | Risk breakdown               |
| 2x2 comparisons     | quadrantChart     | Priority matrices            |
| Temporal sequences  | timeline          | Roadmaps                     |
| State changes       | stateDiagram-v2   | System states                |

### Anti-Patterns to Avoid
- Deep horizontal trees (5+ branches with children)
- Extremely tall diagrams (800+ pixels)
- Too many nodes (15-20 max)
- Long node labels (2-4 words max per node)
- Single arrow -> (use --> for flowchart arrows)
- Sequence diagrams (avoid — use tables instead)

### MDX Component Format
\`\`\`jsx
import { MermaidDiagram } from '@components/wiki/MermaidDiagram';

<MermaidDiagram chart={\`
flowchart TD
    A[Node A] --> B[Node B]
    B --> C[Node C]
    style A fill:#cceeff
\`} />
\`\`\`
`;

export const SQUIGGLE_STYLE_GUIDE = `
## Squiggle Model Style Guide

### Core Principles
- Use distributions, NEVER point values in mixture() calls
- Use "X to Y" syntax for uncertain quantities (e.g., 100 to 500)
- Keep models 5-30 lines
- Name variables clearly and descriptively
- Default sampleCount: 5000

### Common Patterns

**Simple estimate:**
\`\`\`
annualCost = 10M to 50M  // Use M/B/T for millions/billions/trillions
\`\`\`

**Mixture of scenarios:**
\`\`\`
// GOOD: use ranges
result = mixture(
  100 to 300,    // optimistic scenario
  300 to 800,    // middle scenario
  800 to 2000,   // pessimistic scenario
  [0.3, 0.5, 0.2]
)

// BAD: point values create jagged spikes
result = mixture(200, 500, 1000, [0.3, 0.5, 0.2])
\`\`\`

**Conditional model:**
\`\`\`
pSuccess = 0.3 to 0.7
benefitIfSuccess = 1B to 10B
benefitIfFailure = -500M to 100M
expectedBenefit = pSuccess * benefitIfSuccess + (1 - pSuccess) * benefitIfFailure
\`\`\`

### MDX Component Format
\`\`\`jsx
import { SquiggleEstimate } from '@components/wiki/SquiggleEstimate';

<SquiggleEstimate
  title="Expected Annual AI Safety Funding"
  code={\`
    currentFunding = 300M to 600M
    growthRate = 1.1 to 1.4
    yearsFuture = 5
    futureFunding = currentFunding * growthRate ^ yearsFuture
    futureFunding
  \`}
/>
\`\`\`

### Anti-Patterns
- Point values in mixtures (creates ugly spikes)
- Overly complex models (>30 lines — split into multiple estimates)
- Missing title prop
- Using exact numbers when ranges are more honest
`;

export const CAUSE_EFFECT_STYLE_GUIDE = `
## CauseEffectGraph Style Guide

### Node Structure
Each node needs: id, position (x, y auto-laid-out), data object with:
- label: short name (2-4 words)
- description: one sentence explanation
- type: 'leaf' | 'cause' | 'intermediate' | 'effect'
- color (optional): rose, red, emerald, green, blue, sky, teal, cyan, violet, purple, amber, yellow, slate, gray

### Edge Structure
Each edge needs: id, source, target, and optional data:
- strength: 'strong' | 'medium' | 'weak'
- effect: 'increases' | 'decreases' | 'mixed'
- label: short description of the relationship

### Design Guidelines
- 5-15 nodes per graph (more becomes unreadable)
- Clear causal flow: causes on top/left, effects on bottom/right
- Use color to group related concepts
- Include edge labels for non-obvious relationships
- Use strength indicators to show relative importance

### MDX Component Format
\`\`\`jsx
import { CauseEffectGraph } from '@components/wiki/CauseEffectGraph';

<CauseEffectGraph
  initialNodes={[
    { id: '1', position: { x: 0, y: 0 }, data: { label: 'Compute Growth', type: 'cause', color: 'blue' } },
    { id: '2', position: { x: 0, y: 0 }, data: { label: 'Model Scale', type: 'intermediate', color: 'sky' } },
    { id: '3', position: { x: 0, y: 0 }, data: { label: 'Capability Jump', type: 'effect', color: 'amber' } },
  ]}
  initialEdges={[
    { id: 'e1-2', source: '1', target: '2', data: { strength: 'strong', effect: 'increases' } },
    { id: 'e2-3', source: '2', target: '3', data: { strength: 'medium', effect: 'increases' } },
  ]}
  height={400}
/>
\`\`\`
`;

export const COMPARISON_STYLE_GUIDE = `
## ComparisonTable Style Guide

### Design Guidelines
- 3-6 columns (more becomes cramped on mobile)
- 3-10 rows (more needs pagination)
- Use badges (high/medium/low) for categorical assessments
- Use the highlightColumn prop to draw attention to key column
- Keep cell values concise (1-3 words or short phrases)

### Badge Usage
- high: green badge — strong/good/positive
- medium: yellow badge — moderate/mixed
- low: red badge — weak/poor/negative

### MDX Component Format
\`\`\`jsx
import { ComparisonTable } from '@components/wiki/ComparisonTable';

<ComparisonTable
  title="AI Governance Approaches"
  columns={["Approach", "Feasibility", "Impact", "Timeline"]}
  rows={[
    {
      name: "International Treaty",
      values: {
        "Feasibility": { value: "Challenging", badge: "low" },
        "Impact": { value: "High", badge: "high" },
        "Timeline": "5-10 years"
      }
    },
    {
      name: "Industry Self-Regulation",
      values: {
        "Feasibility": { value: "High", badge: "high" },
        "Impact": { value: "Limited", badge: "low" },
        "Timeline": "1-2 years"
      }
    },
  ]}
/>
\`\`\`
`;

export const DISAGREEMENT_STYLE_GUIDE = `
## DisagreementMap Style Guide

### Design Guidelines
- 2-5 positions (more becomes overwhelming)
- Each position should have a clear name/actor, description, and confidence
- Include evidence or reasoning where possible
- Use strength (1-5) to indicate confidence level
- Include proponents for credibility

### Position Schema
Each position supports two schemas:
- Schema A: name, description, confidence, proponents, evidence
- Schema B: actor, position, estimate, reasoning, quote

### MDX Component Format
\`\`\`jsx
import { DisagreementMap } from '@components/wiki/DisagreementMap';

<DisagreementMap
  topic="When will transformative AI arrive?"
  positions={[
    {
      name: "Near-term (before 2030)",
      description: "Rapid scaling of current architectures will reach AGI-level capabilities within this decade.",
      strength: 4,
      proponents: ["Dario Amodei", "Sam Altman"],
      evidence: ["GPT-4 performance on professional exams", "Exponential compute scaling"]
    },
    {
      name: "Medium-term (2030-2050)",
      description: "Fundamental breakthroughs beyond scaling are needed, but achievable within decades.",
      strength: 3,
      proponents: ["Yoshua Bengio"],
      evidence: ["Current limitations in reasoning", "Historical pace of AI progress"]
    },
  ]}
/>
\`\`\`
`;

// ============================================================================
// Style guide lookup (shared by visual-create and visual-improve)
// ============================================================================

export function getStyleGuide(type: string): string {
  switch (type) {
    case 'mermaid':
      return MERMAID_STYLE_GUIDE;
    case 'squiggle':
      return SQUIGGLE_STYLE_GUIDE;
    case 'cause-effect':
      return CAUSE_EFFECT_STYLE_GUIDE;
    case 'comparison':
      return COMPARISON_STYLE_GUIDE;
    case 'disagreement':
      return DISAGREEMENT_STYLE_GUIDE;
    default:
      return '';
  }
}

// ============================================================================
// Visual review prompts
// ============================================================================

export const VISUAL_REVIEW_SYSTEM_PROMPT = `You are a visual quality reviewer for an AI safety wiki.
You review rendered diagrams and charts for clarity, accuracy, and visual quality.

Rate each visual on a 0-100 scale across these dimensions:
- Clarity: Is the visual easy to understand at a glance?
- Accuracy: Does it correctly represent the underlying concepts?
- Aesthetics: Is it visually clean and well-organized?
- Relevance: Does it add value to the page content?

Return a JSON object:
{
  "score": <0-100 overall>,
  "strengths": ["list of what works well"],
  "issues": ["list of problems found"],
  "suggestions": ["list of specific improvements"]
}`;

export const VISUAL_SUGGEST_TYPE_PROMPT = `You are analyzing a wiki page to determine which visual types would best complement the content.

For each suggested visual, explain:
1. What type (mermaid, squiggle, cause-effect, comparison, disagreement)
2. What specific concept it should visualize
3. Where in the page it should be placed (after which section heading)

Consider:
- Mermaid: good for processes, hierarchies, categorizations, timelines
- Squiggle: good for uncertain quantities, forecasts, cost estimates
- CauseEffectGraph: good for causal relationships, influence diagrams
- ComparisonTable: good for comparing approaches, organizations, methods
- DisagreementMap: good for contested topics with multiple expert positions

Return a JSON array of suggestions:
[
  {
    "type": "mermaid",
    "concept": "AI risk taxonomy showing major risk categories",
    "placement": "after Overview section",
    "priority": "high"
  }
]`;
