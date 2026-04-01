# opencode

Experimental agent IDE and runtime for coding tasks, built with LangGraph, MySQL, Redis, a web workbench, and benchmark tooling for SWE-bench Lite.

[中文 README](./README.zh-CN.md)

## Status

This repository is not a finished product. It is an active engineering sandbox focused on:

- a persisted agent runtime with LangGraph orchestration
- a browser-based IDE shell for sessions, files, and terminal actions
- MiniMax and Claude provider adapters
- a headless SWE-bench Lite runner and official harness workflow

The current state is best described as: implemented in parts, validated in parts, still incomplete as a full agent IDE.

Useful project status documents:

- [Reading Guide](./docs/reading-guide.md)
- [Progress Log](./docs/progress.md)
- [Definition of Done](./docs/agent-definition-of-done.md)
- [Architecture Notes](./docs/agent-architecture.md)

## What is in the repo

- `apps/ide-web`
  Minimal web IDE shell, provider hooks, browser endpoints, and dev server.
- `packages/core`
  Core domain entities such as sessions, goals, plans, tasks, memory, and tool policy.
- `packages/runtime`
  LangGraph workflow contracts, runtime orchestration, and application services.
- `packages/db`
  MySQL repositories, Redis-backed caches, bootstrap, and checkpoint persistence.
- `packages/tools`
  Built-in file and shell-oriented tools used by the runtime.
- `packages/evals`
  Smoke scripts, benchmark runners, and SWE-bench Lite export helpers.
- `docs`
  Architecture, reading order, deep-dive notes, benchmark instructions, and interview notes.

## Local setup

### Prerequisites

- Node.js
- `pnpm` 10.x
- Docker Desktop
- Python 3 for the SWE-bench export script

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create local environment config

```bash
cp .env.example .env
```

At minimum, configure:

- MySQL / Redis connection values
- one LLM provider
  - `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`
  - or the Claude env vars if you are using the Anthropic-compatible path

### 3. Start infrastructure

```bash
pnpm infra:up
```

The repository ships with:

- MySQL 8.4
- Redis 7

Compose file:
- [compose.yaml](./compose.yaml)

### 4. Run the web IDE

```bash
pnpm dev:ide-web
```

The dev server listens on `127.0.0.1:3440` by default.

## Smoke checks

Persistence smoke:

```bash
pnpm smoke:persistence
```

MiniMax smoke:

```bash
pnpm smoke:minimax
```

Type check:

```bash
pnpm typecheck
```

## SWE-bench Lite

This repository includes a headless runner that produces `predictions.json` for the official SWE-bench harness.

Primary files:

- [packages/evals/src/swebench-lite.ts](./packages/evals/src/swebench-lite.ts)
- [packages/evals/scripts/export_swebench_lite_subset.py](./packages/evals/scripts/export_swebench_lite_subset.py)
- [docs/swebench-lite.md](./docs/swebench-lite.md)

Export a small instance set:

```bash
pnpm bench:swebench:export --count 5 --output .benchmarks/swebench-lite/instances.json
```

Run the local Lite runner:

```bash
LLM_PROVIDER=minimax pnpm bench:swebench:lite -- \
  --instances-file .benchmarks/swebench-lite/instances.json \
  --run-id swebench-lite-manual-1
```

Then evaluate the generated predictions in the official `SWE-bench` repository:

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path /path/to/opencode/.benchmarks/swebench-lite/runs/swebench-lite-manual-1/predictions.json \
  --instance_ids <instance ids...> \
  --max_workers 1 \
  --run_id swebench-lite-manual-1 \
  --namespace ''
```

## Recommended reading order

Start here if you want to understand the codebase instead of only running it:

1. [docs/reading-guide.md](./docs/reading-guide.md)
2. [docs/langgraph-in-project.md](./docs/langgraph-in-project.md)
3. [docs/project-deep-dive.md](./docs/project-deep-dive.md)
4. [docs/progress.md](./docs/progress.md)

## Suggested GitHub description

Experimental agent IDE and LangGraph runtime with MySQL/Redis persistence, MiniMax/Claude providers, a web workbench, and SWE-bench Lite tooling.
