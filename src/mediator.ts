// The orchestrator. Owns the round loop, diffs the two models' reasoning,
// detects convergence, renders the debate into Copilot Chat, and — only after a
// human checkpoint — has Claude apply the agreed change.

import * as vscode from "vscode";
import { ClaudeDriver, ClaudeError } from "./claudeDriver";
import { CopilotDriver, CopilotError } from "./copilotDriver";
import { SharedContext, gatherFileExcerpts } from "./sharedContext";
import {
  Proposal,
  Critique,
  AgentId,
  DEBATE_SYSTEM_PROMPT,
  PROPOSAL_SCHEMA,
  CRITIQUE_SCHEMA,
  buildProposalPrompt,
  buildCritiquePrompt,
  buildApplyPrompt,
  rootCausesAgree,
} from "./protocol";

export interface MediatorConfig {
  claudePath: string;
  claudeModel: string;
  copilotFamily: string;
  turnCap: number;
  autoResolve: boolean;
  claudeTimeoutMs: number;
  cwd: string;
}

interface ConvergedSession {
  claude: ClaudeDriver;
  agreedRootCause: string;
  agreedChange: string;
}

export class Mediator {
  /** Carries the converged result + Claude session from a debate to a later /apply. */
  private last: ConvergedSession | undefined;

  constructor(private readonly cfg: MediatorConfig) {}

  /** Entry point for a fresh problem (default invocation or /again). */
  async debate(
    problem: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    // Parse `--auto-resolve` flag to override the setting for this debate.
    let autoResolveOverride: boolean | undefined;
    let cleanProblem = problem;
    if (problem.trim().startsWith("--auto-resolve")) {
      autoResolveOverride = true;
      cleanProblem = problem.trim().replace(/^--auto-resolve\s+/, "");
    }

    if (!cleanProblem.trim()) {
      stream.markdown(
        "Tell me what to debate, e.g. `@tag-team why does the session token expire on refresh?` or use `/auto-resolve` to auto-apply if they agree."
      );
      return;
    }

    const claude = new ClaudeDriver({
      claudePath: this.cfg.claudePath,
      model: this.cfg.claudeModel,
      cwd: this.cfg.cwd,
      timeoutMs: this.cfg.claudeTimeoutMs,
    });
    const copilot = new CopilotDriver(this.cfg.copilotFamily);
    const ctx = new SharedContext(cleanProblem, gatherFileExcerpts());

    let proposals: Proposal[];
    try {
      stream.progress("Round 1 — both engineers diagnosing the root cause in parallel…");
      proposals = await this.proposalRound(ctx, claude, copilot, token);
    } catch (err) {
      this.reportError(err, stream);
      return;
    }

    this.renderProposals(proposals, stream);

    let converged = rootCausesAgree(
      proposals[0].rootCauseHypothesis,
      proposals[1].rootCauseHypothesis
    );
    let round = 1;

    // Cross-critique rounds until they agree or we hit the turn cap.
    while (!converged && round < this.cfg.turnCap && !token.isCancellationRequested) {
      round++;
      stream.progress(`Round ${round} — cross-critique: each engineer challenges the other…`);
      let critiques: Critique[];
      try {
        critiques = await this.critiqueRound(ctx, claude, copilot, proposals, token);
      } catch (err) {
        this.reportError(err, stream);
        return;
      }
      this.renderCritiques(critiques, stream);

      // Fold revised root causes back into the working proposals.
      proposals = proposals.map((p, i) => ({
        ...p,
        rootCauseHypothesis: critiques[i].revisedRootCause || p.rootCauseHypothesis,
        confidence: critiques[i].confidence,
      }));
      converged = rootCausesAgree(
        proposals[0].rootCauseHypothesis,
        proposals[1].rootCauseHypothesis
      );
    }

    await this.checkpoint(converged, proposals, claude, ctx, stream, token, autoResolveOverride);
  }

  /** Entry point for /apply after the user approved a checkpoint. */
  async apply(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (!this.last) {
      stream.markdown(
        "Nothing to apply yet — run `@tag-team <problem>` first and approve the diagnosis."
      );
      return;
    }
    const { claude, agreedRootCause, agreedChange } = this.last;
    stream.progress("Claude is applying the agreed change…");
    try {
      const res = await claude.apply(
        buildApplyPrompt(agreedRootCause, agreedChange),
        "You are applying a change agreed by two engineers. Make only that change.",
        (text) => stream.markdown(text)
      );
      stream.markdown(`\n\n---\n✅ **Applied.** ${res.resultText || ""}`);
      this.last = undefined;
    } catch (err) {
      this.reportError(err, stream);
    }
  }

  // --- rounds ---------------------------------------------------------------

  private async proposalRound(
    ctx: SharedContext,
    claude: ClaudeDriver,
    copilot: CopilotDriver,
    token: vscode.CancellationToken
  ): Promise<Proposal[]> {
    const packet = ctx.packet();
    const prompt = buildProposalPrompt(packet);

    const [claudeRaw, copilotRaw] = await Promise.all([
      claude
        .structured(prompt, PROPOSAL_SCHEMA, DEBATE_SYSTEM_PROMPT)
        .then((r) => r.structured ?? r.resultText),
      copilot.send(DEBATE_SYSTEM_PROMPT, prompt, token),
    ]);

    return [
      coerceProposal("claude", claudeRaw),
      coerceProposal("copilot", copilotRaw),
    ];
  }

  private async critiqueRound(
    ctx: SharedContext,
    claude: ClaudeDriver,
    copilot: CopilotDriver,
    proposals: Proposal[],
    token: vscode.CancellationToken
  ): Promise<Critique[]> {
    const packet = ctx.packet();
    const [claudeProp, copilotProp] = proposals;

    const [claudeRaw, copilotRaw] = await Promise.all([
      claude
        .structured(
          buildCritiquePrompt(packet, claudeProp, copilotProp),
          CRITIQUE_SCHEMA,
          DEBATE_SYSTEM_PROMPT
        )
        .then((r) => r.structured ?? r.resultText),
      copilot.send(
        DEBATE_SYSTEM_PROMPT,
        buildCritiquePrompt(packet, copilotProp, claudeProp),
        token
      ),
    ]);

    return [
      coerceCritique("claude", claudeRaw),
      coerceCritique("copilot", copilotRaw),
    ];
  }

  // --- checkpoint & rendering ----------------------------------------------

  private async checkpoint(
    converged: boolean,
    proposals: Proposal[],
    claude: ClaudeDriver,
    ctx: SharedContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    autoResolveOverride?: boolean
  ): Promise<void> {
    const [a, b] = proposals;
    const shouldAutoResolve = autoResolveOverride ?? this.cfg.autoResolve;

    if (converged) {
      const agreedRootCause = a.rootCauseHypothesis;
      const lead = a.confidence >= b.confidence ? a : b;
      ctx.recordDecision(`Agreed root cause: ${agreedRootCause}`);
      this.last = { claude, agreedRootCause, agreedChange: lead.proposedChange };

      if (shouldAutoResolve) {
        stream.markdown(
          `\n\n---\n### ✅ Converged — auto-applying\n**Root cause:** ${agreedRootCause}\n\n**Change (${lead.agent}):** ${lead.proposedChange}\n`
        );
        await this.apply(stream, token);
      } else {
        stream.markdown(
          `\n\n---\n### ✅ Converged\n**Root cause:** ${agreedRootCause}\n\n**Proposed change (${lead.agent}):** ${lead.proposedChange}\n\nReview it, then run \`/apply\` to let Claude make the edit, or \`/again\` to debate further.`
        );
        stream.button({ command: "tag-team.apply", title: "Apply via Claude" });
      }
    } else {
      stream.markdown(
        `\n\n---\n### ⚖️ Unresolved after ${this.cfg.turnCap} rounds — you decide\nThe two engineers still disagree on the root cause:\n\n- **claude:** ${a.rootCauseHypothesis}\n- **copilot:** ${b.rootCauseHypothesis}\n\nPick a side and re-run with more context, or \`/again\` for another round.`
      );
    }

    const file = await ctx.persist(proposals);
    if (file) {
      stream.markdown(`\n\n_Design doc saved to \`.tagteam/session.md\`._`);
    }
  }

  private renderProposals(proposals: Proposal[], stream: vscode.ChatResponseStream): void {
    stream.markdown("\n### Round 1 — independent diagnoses\n");
    for (const p of proposals) {
      stream.markdown(
        `\n**${icon(p.agent)} ${p.agent}** (confidence ${p.confidence.toFixed(2)})\n` +
          `- _Root cause:_ ${p.rootCauseHypothesis}\n` +
          `- _Change:_ ${p.proposedChange}\n` +
          (p.openQuestions.length
            ? `- _Open questions:_ ${p.openQuestions.join("; ")}\n`
            : "")
      );
    }
    const agree = rootCausesAgree(
      proposals[0].rootCauseHypothesis,
      proposals[1].rootCauseHypothesis
    );
    stream.markdown(
      agree
        ? "\n> 🟢 They independently landed on the **same** root cause.\n"
        : "\n> 🔴 They **disagree** on the root cause — moving to cross-critique.\n"
    );
  }

  private renderCritiques(critiques: Critique[], stream: vscode.ChatResponseStream): void {
    for (const c of critiques) {
      stream.markdown(
        `\n**${icon(c.agent)} ${c.agent}** — ${c.concede ? "🤝 concedes" : "🛡️ holds ground"}\n` +
          `- ${c.argument}\n` +
          `- _Now thinks:_ ${c.revisedRootCause}\n`
      );
    }
  }

  private reportError(err: unknown, stream: vscode.ChatResponseStream): void {
    if (err instanceof ClaudeError || err instanceof CopilotError) {
      stream.markdown(`\n\n❌ **${err.message}**`);
      if (err.hint) stream.markdown(`\n\n💡 ${err.hint}`);
    } else if (err instanceof Error) {
      stream.markdown(`\n\n❌ ${err.message}`);
    } else {
      stream.markdown(`\n\n❌ Unexpected error.`);
    }
  }
}

// --- tolerant parsing -------------------------------------------------------

function icon(agent: AgentId): string {
  return agent === "claude" ? "🟣" : "🔵";
}

/** Pull the first JSON object out of a model reply that may be wrapped in prose. */
function parseLooseJson(raw: unknown): any {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw ?? "");
  const fenced = text.replace(/```(?:json)?/gi, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(fenced.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return {};
}

function coerceProposal(agent: AgentId, raw: unknown): Proposal {
  const o = parseLooseJson(raw);
  return {
    agent,
    rootCauseHypothesis: str(o.rootCauseHypothesis) || "(no root cause returned)",
    proposedChange: str(o.proposedChange) || "(no change proposed)",
    reasoning: str(o.reasoning),
    confidence: num(o.confidence),
    openQuestions: Array.isArray(o.openQuestions) ? o.openQuestions.map(str) : [],
  };
}

function coerceCritique(agent: AgentId, raw: unknown): Critique {
  const o = parseLooseJson(raw);
  return {
    agent,
    concede: Boolean(o.concede),
    argument: str(o.argument) || "(no argument returned)",
    revisedRootCause: str(o.revisedRootCause),
    confidence: num(o.confidence),
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}
