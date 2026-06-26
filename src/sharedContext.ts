// The canonical shared memory for a debate session.
//
// The Copilot model (via vscode.lm) is stateless per request, and Claude's CLI
// session is a separate process. Neither can see the other's history. This file
// is the bridge: it owns a running design doc / decision log persisted to
// `.tagteam/session.md` in the workspace, and assembles the per-round context
// packet that both models receive verbatim so they argue over the same facts.

import * as vscode from "vscode";
import { Proposal } from "./protocol";

export class SharedContext {
  private decisionLog: string[] = [];

  constructor(
    private readonly problem: string,
    private readonly fileExcerpts: string
  ) {}

  /** Build the packet sent to both models at the start of a round. */
  packet(): string {
    const log =
      this.decisionLog.length > 0
        ? `\nDECISION LOG (settled — do not re-litigate):\n${this.decisionLog
            .map((d, i) => `${i + 1}. ${d}`)
            .join("\n")}`
        : "";
    return `PROBLEM:
${this.problem}

RELEVANT CODE CONTEXT:
${this.fileExcerpts || "(no files were attached; ask for what you need in openQuestions)"}${log}`;
  }

  recordDecision(text: string): void {
    this.decisionLog.push(text);
  }

  /** Render a markdown design doc summarizing the session so far. */
  toMarkdown(proposals: Proposal[]): string {
    const lines: string[] = [
      "# Tag-Team session",
      "",
      "## Problem",
      this.problem,
      "",
      "## Proposals",
    ];
    for (const p of proposals) {
      lines.push(
        `### ${p.agent}`,
        `- **Root cause:** ${p.rootCauseHypothesis}`,
        `- **Confidence:** ${p.confidence}`,
        `- **Change:** ${p.proposedChange}`,
        ""
      );
    }
    if (this.decisionLog.length) {
      lines.push("## Decision log");
      this.decisionLog.forEach((d) => lines.push(`- ${d}`));
    }
    return lines.join("\n");
  }

  /** Persist the design doc to .tagteam/session.md if a workspace is open. */
  async persist(proposals: Proposal[]): Promise<vscode.Uri | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    const dir = vscode.Uri.joinPath(folder.uri, ".tagteam");
    const file = vscode.Uri.joinPath(dir, "session.md");
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(
      file,
      Buffer.from(this.toMarkdown(proposals), "utf8")
    );
    return file;
  }
}

/** Collect code context from the active editor selection / open document, capped
 *  so we never blow the model's context window. */
export function gatherFileExcerpts(maxChars = 6000): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return "";
  const doc = editor.document;
  const sel = editor.selection;
  const rel = vscode.workspace.asRelativePath(doc.uri);
  const body =
    sel && !sel.isEmpty ? doc.getText(sel) : doc.getText();
  const clipped = body.length > maxChars ? body.slice(0, maxChars) + "\n…(truncated)…" : body;
  const where = sel && !sel.isEmpty ? ` (lines ${sel.start.line + 1}-${sel.end.line + 1})` : "";
  return `File: ${rel}${where}\n\`\`\`\n${clipped}\n\`\`\``;
}
