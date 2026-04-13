# pi-advisor

> A [Pi](https://github.com/RimuruW/pi-advisor) extension that adds a strategic advisor tool for complex coding agent tasks.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm package](https://img.shields.io/npm/v/pi-advisor)](https://www.npmjs.com/package/pi-advisor)

## Overview

`pi-advisor` adds an `advisor` tool to the Pi coding agent, modeled after [Anthropic's advisor tool pattern](https://claude.com/blog/the-advisor-strategy): the executor model keeps doing the work and only consults a stronger "advisor" model when it needs strategic guidance — not for syntax-level questions or routine implementation steps.

The advisor sees a curated transcript, understands the current task stage, and returns a verdict plus numbered action items.

## Features

- **Stage-aware guidance** — automatically detects whether the executor is exploring, stuck, or ready for final verification, and tailors the advisor prompt accordingly
- **Curated context** — sends only relevant conversation history, bounded system prompt, and recent tool activity to keep token usage efficient
- **Configurable model & effort** — choose any provider/model and tune reasoning effort (`minimal`–`xhigh`), token budget, and context window
- **Slash commands** — `/advisor on`, `/advisor off`, `/advisor config`, `/advisor ask` with tab completion
- **Compact TUI rendering** — advisor output renders inline with token usage, stage label, and expand-to-read hint

## Install

### From npm

```bash
pi install npm:pi-advisor
```

### From git

```bash
pi install git:github.com/RimuruW/pi-advisor
```

This is a pi package — install via npm, git, or local path.

## Usage

Enable the advisor with the default model:

```
/advisor on
```

Enable with a specific model:

```
/advisor on anthropic/claude-opus-4-6
```

### Commands

| Command | Description |
|---|---|
| `/advisor` | Show current status |
| `/advisor on [provider/model]` | Enable advisor (optionally set model) |
| `/advisor off` | Disable advisor |
| `/advisor config` | Show full configuration |
| `/advisor config key=value` | Set a config value |
| `/advisor ask` | Manually trigger advisor consultation |

### Configuration

```
/advisor config maxContextMessages=24
/advisor config reasoning=xhigh
/advisor config maxTokens=16384
```

| Key | Default | Description |
|---|---|---|
| `provider` | `anthropic` | Model provider |
| `model` | `claude-opus-4-6` | Model identifier |
| `maxUsesPerRun` | `3` | Max advisor calls per agent run |
| `maxTokens` | `8192` | Max output tokens per advisor call |
| `reasoning` | `high` | Reasoning effort level (`minimal`, `low`, `medium`, `high`, `xhigh`) |
| `maxContextMessages` | `18` | Max transcript messages sent to advisor |

Configuration persists to `~/.pi/agent/advisor.json`.

## Architecture

```
┌─────────────────────────────────────────┐
│              Executor (LLM)              │
│  ┌───────────────────────────────────┐   │
│  │  Decides when to call advisor      │   │
│  │  Reads advisor output & acts       │   │
│  └──────────────┬────────────────────┘   │
└─────────────────┼───────────────────────┘
                  │ advisor(params)
                  ▼
┌─────────────────────────────────────────┐
│           Advisor Extension              │
│                                          │
│  1. Detect current stage                 │
│     (initial / recovery / final-check)   │
│  2. Build curated context:               │
│     - Bounded system prompt              │
│     - Active tools summary               │
│     - Recent tool activity               │
│     - Transcript (first + last N msgs)   │
│  3. Call advisor model via pi-ai         │
│  4. Return verdict + action items        │
└─────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│           Advisor Model (LLM)            │
│  Stronger model, returns:                │
│  - Verdict: "On track" /                 │
│             "Course-correct" /           │
│             "Not done yet"               │
│  - Numbered action items (≤ 5)          │
│  - References to files, commands,        │
│    or error signals from transcript      │
└─────────────────────────────────────────┘
```

### Stage Detection

The extension infers the executor's current stage from recent tool activity:

| Stage | Trigger |
|---|---|
| **initial** | Exploratory reads/commands, no file mutations yet |
| **recovery** | Recent failure, or off-track implementation |
| **final-check** | Changes exist and verification output is in transcript |

## Project Structure

```
.
├── index.ts              # Extension entrypoint (tool + command registration)
├── src/
│   └── advisor-messages.ts   # Transcript curation for advisor context
├── tests/
│   └── package.test.mjs      # Package manifest & smoke tests
├── package.json
├── CHANGELOG.md
├── README.md
└── LICENSE
```

## Development

```bash
# Run tests
npm test

# Smoke-load as an extension
pi -e ./index.ts
```

## License

MIT. See [LICENSE](LICENSE).
