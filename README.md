# Tag-Team LLM Coding

Put **Claude Code** and **GitHub Copilot** in structured debate inside VS Code, so they
converge on a *root cause* before any edit — breaking the single-agent
"guess → patch → analyze → repeat" loop on complex codebases.

## How it works

You invoke `@tag-team <problem>` in the Copilot Chat panel. The extension acts as a
**mediator**:

1. **Proposal round (parallel)** — Claude (via the `claude -p` CLI, with file/terminal
   tools) and Copilot (via the VS Code Language Model API) each return a *structured
   proposal*: a committed root-cause hypothesis, a proposed change, confidence, and open
   questions. They cannot hand back a patch without first naming a root cause.
2. **Cross-critique** — each model is shown the other's proposal and must refute it with
   evidence or concede. This is the loop-breaker: it forces engagement with an outside view
   instead of re-patching its own guess.
3. **Convergence / checkpoint** — when both agree (or after `turnCap` rounds) the mediator
   pauses and shows you the agreed diagnosis. **You** approve.
4. **Apply** — on `/apply`, Claude (the only side with autonomous file tools) makes the
   edit. A design doc is saved to `.tagteam/session.md`.

| Concern | Choice |
| --- | --- |
| Role split | Symmetric debate; only Claude edits files |
| UI | Copilot Chat participant (`@tag-team`) |
| Claude auth | `claude -p` CLI on your Pro/Max subscription (no API key) |
| Control | Selectable — checkpointed or auto-resolve (see Settings) |

## Prerequisites

- VS Code ≥ 1.95
- **GitHub Copilot** installed and signed in (provides the second model)
- **Claude Code CLI** installed and logged in. Run `claude` once in a terminal to log in.
  If `claude` is not on the PATH VS Code sees, set `tagTeam.claudePath` to its absolute
  path (e.g. `~/.claude/local/claude`).

## Develop / run

```bash
npm install
npm run package:vsix
```

Then press **F5** ("Run Tag-Team Extension") to open an Extension Development Host.

## Marketplace package

Run the packaging command below to produce the distributable VSIX:

```bash
npm run package:vsix
```

The generated file will be written to the project root as `tag-team-llm-<version>.vsix`.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `tagTeam.claudePath` | `claude` | Path to the Claude CLI |
| `tagTeam.claudeModel` | _(blank)_ | Optional `--model` override |
| `tagTeam.copilotFamily` | `gpt-4o` | Copilot model family |
| `tagTeam.turnCap` | `3` | Max debate rounds before checkpoint |
| `tagTeam.autoResolve` | `false` | When `true`, Claude applies the change automatically once both models agree on a root cause. If they never agree, you still decide. |
| `tagTeam.claudeTimeoutMs` | `180000` | Per-turn Claude timeout |

## Per-invocation flag

Even if `tagTeam.autoResolve` is `false`, you can force auto-resolve for a single debate using the `/auto-resolve` slash command:

```
@tag-team /auto-resolve why does the login hang on refresh?
```

Type `@tag-team /` in Copilot Chat and the available commands will autocomplete. If the models agree on a root cause, Claude will apply the change immediately. If they never agree (even after `turnCap` rounds), you'll still get the tie-break prompt.

## Limitations

- The Copilot model is text-only here; it shapes the plan but does not edit files.
- Copilot may not return strict JSON — parsing is tolerant; Claude is schema-enforced.
- Headless Claude turns add latency; keep `turnCap` low for fast iteration.
