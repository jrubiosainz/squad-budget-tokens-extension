# squad-budget-tokens

> Token budget guard for GitHub Copilot CLI Squad sessions.

Stop runaway autopilot loops from burning your token budget. **squad-budget-tokens** is a lightweight extension that puts a live local dashboard in your browser, lets you set a max number of **input / output / cached tokens** per session, shows you token consumption broken down by Squad agent in real time, and kills autopilot when any budget is hit. Local-inference tokens (served by on-device models on `127.0.0.1`, e.g. Foundry Local) are tracked separately and **don't** count against the premium budgets.

> Sister project: [`github-copilot-budget-extension`](https://github.com/jrubiosainz/github-copilot-budget-extension) tracks **premium requests**. This one tracks **tokens** — install both side-by-side; they listen on different ports and don't conflict.

## What you get

- A local dashboard at `http://127.0.0.1:51954/` that opens automatically when you start a Squad session.
- Set a max number of **input**, **output**, and **cached** tokens per session — no signup, no API keys, entirely local.
- See live per-agent token consumption (Coordinator + every subagent dispatched via the `task` tool).
- Three independent budgets (input / output / cached). When **any** of them is hit, autopilot aborts and further tool calls are denied.
- Local-inference tokens (on-device models on `127.0.0.1`, e.g. Foundry Local) are tracked separately and labeled `LOCAL/FREE` — they **don't** count against the premium budgets.

## Dashboard sketch

```
┌────────────────────────────────────────────────────────────────────┐
│  squad-budget-tokens Dashboard                       [●] Live      │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Max input tokens:  [200000]   Max output tokens: [50000]          │
│  Max cached tokens: [2000000]  [Set Budget]                        │
│                                                                    │
│  Per-agent breakdown:                                              │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Coordinator     in: 18.4k  out: 6.2k  cached: 412k           │  │
│  │ Ripley          in:  9.1k  out: 3.0k  cached: 180k           │  │
│  │ Hicks           in:  2.3k  out: 0.8k  cached:  44k           │  │
│  │ obrien (LOCAL)  in:  1.7k  out: 0.4k  cached:   0            │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Status: Running — input 29.8k / 200k · output 10k / 50k           │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Requirements

- **Node.js 20+**
- **GitHub Copilot CLI** installed and working
- A **Squad workspace** (a repo with `.squad/` folder or `.github/agents/squad.agent.md`)
  - The extension only activates in Squad workspaces; it's silent elsewhere.

## Install

### One-liner (any platform)

```bash
git clone https://github.com/jrubiosainz/squad-budget-tokens-extension
cd squad-budget-tokens-extension
npm run install:ext
```

### Windows (PowerShell)

```powershell
git clone https://github.com/jrubiosainz/squad-budget-tokens-extension
cd squad-budget-tokens-extension
.\scripts\install.ps1
```

### macOS / Linux

```bash
git clone https://github.com/jrubiosainz/squad-budget-tokens-extension
cd squad-budget-tokens-extension
./scripts/install.sh
```

**What the installer does:**
- Copies `src/extension.mjs` to `~/.copilot/extensions/squad-budget-tokens/extension.mjs`
- The Copilot CLI auto-discovers it on next start

## Use it

1. `cd` into a Squad workspace (one with `.squad/` or `.github/agents/squad.agent.md`).
2. Start a Copilot CLI session (e.g., `copilot task` or `copilot explore`).
3. The dashboard opens automatically at `http://127.0.0.1:51954/`.
4. Enter your max input / output / cached token budgets and click **Set Budget**.
5. Work normally. Watch the per-agent breakdown fill up in real time. When any budget hits zero, the session aborts.

## Uninstall

```bash
npm run uninstall:ext
```

Or manually:

```powershell
# Windows
.\scripts\uninstall.ps1

# macOS / Linux
./scripts/uninstall.sh
```

## How it works

The extension hooks into the Copilot SDK `joinSession()` API to intercept every model-usage event. It sums **input**, **output**, and **cached** tokens reported by `*.usage` SDK events (handling both OpenAI-style `prompt_tokens` / `completion_tokens` and Anthropic-style `input_tokens` / `output_tokens` / `cache_read_input_tokens` field shapes). A tiny HTTP server spawns on `127.0.0.1:51954` with Server-Sent Events (SSE) to push live per-agent consumption updates to the browser.

Per-agent breakdown comes from parsing the `task` tool's `squad_member_id` metadata, so you see the Coordinator turns separately from each subagent dispatched. Local-inference tokens (calls to on-device endpoints on `127.0.0.1`, e.g. Foundry Local) are counted into a `LOCAL/FREE` channel that doesn't consume budget.

When any of the three budgets is exhausted, the extension calls `session.abort()` **and** blocks further tool calls — the abort kills autopilot loops; denying tool calls alone wasn't enough to stop them.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Dashboard doesn't open | Ensure your repo has `.squad/` or `.github/agents/squad.agent.md`. The extension is silent if not in a Squad workspace. |
| Port 51954 already in use | Another `squad-budget-tokens` instance is running. Close the other Copilot CLI session. |
| Install script does nothing | Check `node -v` (must be ≥20). Re-run the install script. |
| Budget still consumed after abort | Expected — tool calls in-flight before the abort complete. Budgets are soft-enforced; set them conservatively. |
| Cached token counts look huge | Cached tokens are typically much higher than input/output — they're discounted by the platform but still surfaced for visibility. Set a generous cached budget (e.g. 2M+). |
| Conflicts with `squad-budget` (premium-request guard) | None — that extension binds port `51953`, this one binds `51954`. Run both. |

## License

MIT — see [LICENSE](./LICENSE).

## Source

Single extension file: [`src/extension.mjs`](./src/extension.mjs). Read it, modify it, send PRs.
