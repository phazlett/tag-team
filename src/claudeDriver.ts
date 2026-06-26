// Drives Claude Code headlessly via the `claude -p` CLI.
//
// Two modes:
//  - structured(): `--output-format json --json-schema <inline>` for proposal /
//    critique turns. Returns the validated object plus the session id.
//  - apply(): `--output-format stream-json` for the final edit turn, streaming
//    assistant text to onProgress and running with --permission-mode acceptEdits.
//
// Session continuity: we capture session_id from Claude's first turn and pass it
// back via --resume so later turns keep the files-already-read tool context.

import { spawn } from "node:child_process";

export interface ClaudeConfig {
  claudePath: string;
  model: string;
  cwd: string;
  timeoutMs: number;
}

export class ClaudeError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "ClaudeError";
  }
}

export interface ClaudeResult {
  resultText: string;
  structured?: unknown;
  sessionId?: string;
}

interface RunOpts {
  prompt: string;
  appendSystemPrompt?: string;
  jsonSchema?: object;
  resume?: string;
  permissionMode?: "plan" | "acceptEdits" | "default";
  onProgress?: (text: string) => void;
}

export class ClaudeDriver {
  /** Stable across a debate session so --resume reuses tool context. */
  sessionId: string | undefined;

  constructor(private readonly cfg: ClaudeConfig) {}

  /** A proposal/critique turn that returns a JSON object matching `jsonSchema`. */
  async structured(
    prompt: string,
    jsonSchema: object,
    appendSystemPrompt: string
  ): Promise<ClaudeResult> {
    return this.run({
      prompt,
      jsonSchema,
      appendSystemPrompt,
      resume: this.sessionId,
      permissionMode: "plan", // read/diagnose only — never edits during debate
    });
  }

  /** The final apply turn: lets Claude actually edit files, streaming progress. */
  async apply(
    prompt: string,
    appendSystemPrompt: string,
    onProgress: (text: string) => void
  ): Promise<ClaudeResult> {
    return this.run({
      prompt,
      appendSystemPrompt,
      resume: this.sessionId,
      permissionMode: "acceptEdits",
      onProgress,
    });
  }

  private async run(opts: RunOpts): Promise<ClaudeResult> {
    const streaming = Boolean(opts.onProgress);
    const args = ["-p", opts.prompt];

    if (streaming) {
      args.push("--output-format", "stream-json", "--verbose");
    } else {
      args.push("--output-format", "json");
    }

    if (opts.jsonSchema) {
      // The CLI expects the schema JSON inline, not a file path.
      args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    }
    if (opts.appendSystemPrompt) {
      args.push("--append-system-prompt", opts.appendSystemPrompt);
    }
    if (opts.resume) {
      args.push("--resume", opts.resume);
    }
    if (opts.permissionMode) {
      args.push("--permission-mode", opts.permissionMode);
    }
    if (this.cfg.model) {
      args.push("--model", this.cfg.model);
    }

    const { stdout } = await this.exec(args, streaming, opts.onProgress);
    const parsed = streaming
      ? this.parseStreamJson(stdout)
      : this.parseJson(stdout);
    if (parsed.sessionId && !this.sessionId) {
      this.sessionId = parsed.sessionId;
    }
    return parsed;
  }

  private exec(
    args: string[],
    streaming: boolean,
    onProgress?: (text: string) => void
  ): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg.claudePath, args, {
        cwd: this.cfg.cwd,
        env: process.env,
        // Ignore stdin so the CLI doesn't block waiting for piped input.
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let lineBuf = "";

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(
          new ClaudeError(
            `Claude timed out after ${this.cfg.timeoutMs}ms`,
            "Increase tagTeam.claudeTimeoutMs or narrow the problem."
          )
        );
      }, this.cfg.timeoutMs);

      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          reject(
            new ClaudeError(
              `Could not find the Claude CLI at "${this.cfg.claudePath}".`,
              "Set tagTeam.claudePath to an absolute path (e.g. ~/.claude/local/claude) or ensure `claude` is on PATH."
            )
          );
        } else {
          reject(new ClaudeError(err.message));
        }
      });

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        if (streaming && onProgress) {
          // Emit assistant text deltas as they arrive (NDJSON, one obj per line).
          lineBuf += text;
          let nl: number;
          while ((nl = lineBuf.indexOf("\n")) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            const delta = this.extractAssistantText(line);
            if (delta) onProgress(delta);
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout });
        } else {
          const lower = stderr.toLowerCase();
          const hint =
            lower.includes("login") || lower.includes("auth") || lower.includes("credential")
              ? "Run `claude` once in a terminal to log in to your subscription, then retry."
              : undefined;
          reject(
            new ClaudeError(
              `Claude exited with code ${code}: ${stderr.trim() || "(no stderr)"}`,
              hint
            )
          );
        }
      });
    });
  }

  /** Parse the single JSON blob from `--output-format json`. */
  private parseJson(stdout: string): ClaudeResult {
    let obj: any;
    try {
      obj = JSON.parse(stdout.trim());
    } catch {
      throw new ClaudeError(`Could not parse Claude JSON output: ${stdout.slice(0, 300)}`);
    }
    return {
      resultText: typeof obj.result === "string" ? obj.result : "",
      structured: obj.structured_output ?? obj.structuredOutput,
      sessionId: obj.session_id ?? obj.sessionId,
    };
  }

  /** Reduce NDJSON stream events to the final result + session id. */
  private parseStreamJson(stdout: string): ClaudeResult {
    let resultText = "";
    let sessionId: string | undefined;
    let structured: unknown;
    for (const raw of stdout.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.session_id && !sessionId) sessionId = ev.session_id;
      if (ev.type === "result") {
        if (typeof ev.result === "string") resultText = ev.result;
        structured = ev.structured_output ?? structured;
      }
    }
    return { resultText, structured, sessionId };
  }

  /** Pull assistant text out of one NDJSON line for progress streaming. */
  private extractAssistantText(line: string): string | undefined {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (ev.type === "assistant" && ev.message?.content) {
      return ev.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
    }
    return undefined;
  }
}
