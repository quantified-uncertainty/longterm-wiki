/** Human-readable labels for expert position topic slugs.
 *
 * Shared between the people directory and individual expert-positions component.
 */
export const TOPIC_LABELS: Record<string, string> = {
  "p-doom": "P(doom)",
  timelines: "AGI Timelines",
  "current-approaches-scale": "Current Approaches Scale",
  "how-hard-is-alignment": "How Hard Is Alignment?",
  "inner-alignment-solvability": "Inner Alignment Solvability",
  "likelihood-of-deceptive-alignment": "Likelihood of Deceptive Alignment",
  "would-misalignment-be-catastrophic": "Would Misalignment Be Catastrophic?",
  "p-ai-catastrophe": "P(AI Catastrophe)",
  "p-ai-x-risk-this-century": "P(AI X-Risk This Century)",
  "how-fast-would-takeoff-be": "Takeoff Speed",
  "will-advanced-ai-systems-be-deceptive": "Will Advanced AI Be Deceptive?",
  "will-we-get-adequate-warning-before-catastrophic-ai":
    "Will We Get Adequate Warning?",
};

/** Convert a topic slug to a human-readable label, falling back to title-case. */
export function topicLabel(topic: string): string {
  return (
    TOPIC_LABELS[topic] ??
    topic.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}
