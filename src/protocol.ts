// Shared types and prompt templates for the tag-team debate protocol.
//
// The whole point of the protocol is to break the "guess -> patch -> analyze ->
// repeat" loop. Every model turn is forced through a structured proposal whose
// first-class field is a *root cause hypothesis*: a model cannot hand back a
// patch without committing to why the bug exists. The cross-critique step then
// makes each model engage the other's reasoning rather than re-patching its own.

export type AgentId = "claude" | "copilot";

export interface Proposal {
  /** Which model produced this. */
  agent: AgentId;
  /** The single most likely underlying cause. Required before any change. */
  rootCauseHypothesis: string;
  /** Concrete change set described in prose (files, functions, the edit). */
  proposedChange: string;
  /** Why this root cause and change follow from the evidence. */
  reasoning: string;
  /** 0..1 self-assessed confidence in the root cause. */
  confidence: number;
  /** Unknowns the model could not resolve from the given context. */
  openQuestions: string[];
}

export interface Critique {
  agent: AgentId;
  /** Does this model now agree with the *other's* root cause hypothesis? */
  concede: boolean;
  /** Evidence-backed refutation or the reason it conceded. */
  argument: string;
  /** If it changed its mind, the updated root cause; otherwise unchanged. */
  revisedRootCause: string;
  confidence: number;
}

/** JSON Schema for a Proposal — passed to `claude -p --json-schema` and inlined
 *  into the Copilot prompt so both sides return the same shape. */
export const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "rootCauseHypothesis",
    "proposedChange",
    "reasoning",
    "confidence",
    "openQuestions",
  ],
  properties: {
    rootCauseHypothesis: { type: "string" },
    proposedChange: { type: "string" },
    reasoning: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    openQuestions: { type: "array", items: { type: "string" } },
  },
} as const;

export const CRITIQUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["concede", "argument", "revisedRootCause", "confidence"],
  properties: {
    concede: { type: "boolean" },
    argument: { type: "string" },
    revisedRootCause: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

const OUTPUT_CONTRACT = `Respond with ONLY a single JSON object, no prose, no markdown fences.`;

/** System framing shared by both models so they play the same game. */
export const DEBATE_SYSTEM_PROMPT = `You are one of two independent AI engineers debating a problem in a real codebase.
Your goal is NOT to patch the first symptom you see. Your goal is to identify the true ROOT CAUSE and only then propose a change.
Rules:
- Always commit to a single most-likely root cause hypothesis.
- Prefer reading evidence over guessing. State what you actually verified vs. assumed.
- A confident wrong answer is worse than an honest "open question".
A second engineer is solving the same problem in parallel; you will later see their proposal and must engage it directly.`;

export function buildProposalPrompt(contextPacket: string): string {
  return `${contextPacket}

TASK: Produce a structured proposal. Identify the root cause first, then the change that follows from it.
The JSON object must have these fields:
- rootCauseHypothesis (string)
- proposedChange (string)
- reasoning (string)
- confidence (number 0..1)
- openQuestions (string[])

${OUTPUT_CONTRACT}`;
}

export function buildCritiquePrompt(
  contextPacket: string,
  own: Proposal,
  other: Proposal
): string {
  return `${contextPacket}

YOUR EARLIER PROPOSAL:
- root cause: ${own.rootCauseHypothesis}
- change: ${own.proposedChange}

THE OTHER ENGINEER'S PROPOSAL:
- root cause: ${other.rootCauseHypothesis}
- change: ${other.proposedChange}
- their reasoning: ${other.reasoning}

TASK: Engage their proposal directly. Either refute it with specific evidence, or concede if they are more likely correct.
Do not restate your original answer unchanged — respond to THEIR argument.
The JSON object must have these fields:
- concede (boolean) — true if you now think their root cause is more likely
- argument (string) — your evidence-backed refutation or concession
- revisedRootCause (string) — your current best root cause after considering theirs
- confidence (number 0..1)

${OUTPUT_CONTRACT}`;
}

/** Prompt used on the final apply step, sent only to Claude (the one with file tools). */
export function buildApplyPrompt(agreedRootCause: string, agreedChange: string): string {
  return `The debate converged. Apply the following agreed change to the workspace.
Make ONLY this change, then summarize what you edited.

Agreed root cause: ${agreedRootCause}

Agreed change set: ${agreedChange}`;
}

/** Heuristic convergence: do the two current root causes describe the same thing? */
export function rootCausesAgree(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3);
  const sa = new Set(norm(a));
  const sb = new Set(norm(b));
  if (sa.size === 0 || sb.size === 0) return false;
  let overlap = 0;
  for (const w of sa) if (sb.has(w)) overlap++;
  const jaccard = overlap / (sa.size + sb.size - overlap);
  return jaccard >= 0.5;
}
