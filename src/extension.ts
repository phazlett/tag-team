// Extension entry point. Registers the @tag-team chat participant and routes
// each turn to the Mediator. The participant lives inside the Copilot Chat panel,
// which also satisfies the language-model API's "user-initiated" requirement.

import * as vscode from "vscode";
import { Mediator, MediatorConfig } from "./mediator";

function readConfig(): MediatorConfig {
  const c = vscode.workspace.getConfiguration("tagTeam");
  const cwd =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return {
    claudePath: c.get<string>("claudePath", "claude"),
    claudeModel: c.get<string>("claudeModel", ""),
    copilotFamily: c.get<string>("copilotFamily", "gpt-4o"),
    turnCap: c.get<number>("turnCap", 3),
    autoResolve: c.get<boolean>("autoResolve", false),
    claudeTimeoutMs: c.get<number>("claudeTimeoutMs", 180000),
    cwd,
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const handler: vscode.ChatRequestHandler = async (
    request,
    _chatContext,
    stream,
    token
  ) => {
    const shared = getMediator(context, readConfig());

    if (request.command === "apply") {
      await shared.apply(stream, token);
    } else if (request.command === "auto-resolve") {
      // Prepend the flag so debate() parses it and sets autoResolve=true.
      const problemWithFlag = `--auto-resolve ${request.prompt}`;
      await shared.debate(problemWithFlag, stream, token);
    } else {
      // default invocation and /again both start/continue a debate
      await shared.debate(request.prompt, stream, token);
    }
    return {};
  };

  const participant = vscode.chat.createChatParticipant("tag-team", handler);
  participant.iconPath = new vscode.ThemeIcon("organization");
  participant.followupProvider = {
    provideFollowups() {
      return [
        { prompt: "", command: "apply", label: "✅ Apply via Claude" },
        { prompt: "", command: "again", label: "🔁 Debate another round" },
      ];
    },
  };
  context.subscriptions.push(participant);

  // Button on the converged checkpoint re-enters the participant with /apply.
  context.subscriptions.push(
    vscode.commands.registerCommand("tag-team.apply", () =>
      vscode.commands.executeCommand("workbench.action.chat.open", {
        query: "@tag-team /apply",
      })
    )
  );
}

// One Mediator instance per window so the converged session survives between the
// debate turn and the follow-up /apply turn.
let singleton: Mediator | undefined;
function getMediator(
  _context: vscode.ExtensionContext,
  cfg: MediatorConfig
): Mediator {
  if (!singleton) {
    singleton = new Mediator(cfg);
  }
  return singleton;
}

export function deactivate(): void {
  singleton = undefined;
}
