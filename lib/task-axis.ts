export const TASK_AXES = ["coding", "agents", "general", "scientific", "writing", "mixed"] as const;
export type TaskAxis = typeof TASK_AXES[number];
const SIGNALS: Record<Exclude<TaskAxis, "mixed">, RegExp> = {
  coding: /\b(code|coding|debug|bug|refactor|implement|typescript|python|repository|unit tests?|pull request|compile)\b/gi,
  agents: /\b(automate|automation|monitor|schedule|workflow|deploy|ops|incident|triage|tools?|browser|mcp)\b/gi,
  general: /\b(research|compare|explain|summarize|analyse|analyze|recommend|lookup|find|search)\b/gi,
  scientific: /\b(scientific|physics|chemistry|biology|theorem|equation|hypothesis|experiment|statistical|proof)\b/gi,
  writing: /\b(write|writing|rewrite|draft|edit|prose|essay|article|email|story|copy|tone|memo)\b/gi,
};
/** Distinct signals reduce repetition bias; ties and unknown work remain mixed. */
export function classifyTask(text: string): TaskAxis {
  const ranks = Object.entries(SIGNALS).map(([axis, pattern]) => ({
    axis: axis as Exclude<TaskAxis, "mixed">,
    count: new Set(text.toLowerCase().match(pattern) ?? []).size,
  })).sort((a, b) => b.count - a.count);
  return ranks[0]!.count === 0 || ranks[0]!.count === ranks[1]!.count ? "mixed" : ranks[0]!.axis;
}
