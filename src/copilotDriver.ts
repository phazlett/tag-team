// Drives a GitHub Copilot model through the built-in VS Code Language Model API.
//
// The Copilot model is stateless per request: every call carries the full prompt
// (the shared context packet lives in SharedContext, not here). selectChatModels
// returns [] when Copilot is not installed/authed — we surface that clearly.

import * as vscode from "vscode";

export class CopilotError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "CopilotError";
  }
}

export class CopilotDriver {
  constructor(private readonly family: string) {}

  private async pickModel(): Promise<vscode.LanguageModelChat> {
    let models = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: this.family,
    });
    if (models.length === 0) {
      // Fall back to any Copilot model before giving up.
      models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    }
    if (models.length === 0) {
      throw new CopilotError(
        `No Copilot chat models are available (requested family "${this.family}").`,
        "Install and sign in to GitHub Copilot, then approve the language-model access prompt."
      );
    }
    return models[0];
  }

  /**
   * Send a single prompt and stream the reply. Progress fragments go to
   * onProgress; the full concatenated text is returned.
   */
  async send(
    systemPrompt: string,
    userPrompt: string,
    token: vscode.CancellationToken,
    onProgress?: (text: string) => void
  ): Promise<string> {
    const model = await this.pickModel();
    const messages = [
      // Copilot has no dedicated system role for extensions; lead with an
      // assistant-framed instruction, then the user content.
      vscode.LanguageModelChatMessage.Assistant(systemPrompt),
      vscode.LanguageModelChatMessage.User(userPrompt),
    ];

    let full = "";
    try {
      const response = await model.sendRequest(messages, {}, token);
      for await (const fragment of response.text) {
        full += fragment;
        onProgress?.(fragment);
      }
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {
        throw new CopilotError(
          `Copilot request failed: ${err.message} (${err.code})`,
          err.code === "NoPermissions"
            ? "Approve the language-model access prompt for this extension."
            : undefined
        );
      }
      throw err;
    }
    return full;
  }
}
