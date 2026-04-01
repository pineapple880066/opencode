# opencode

一个面向代码任务的实验性 Agent IDE 与 runtime。当前仓库把 LangGraph 编排、MySQL/Redis 持久化、Web 工作台、模型适配层，以及 SWE-bench Lite 跑法放在同一个 TypeScript monorepo 里。

[English README](./README.md)

## 当前状态

这个仓库不是完整产品，当前更准确的描述是：

- 已经有可运行的部分
- 已经有部分强验证和 benchmark 工具
- 但还没有达到完整 agent IDE 的完成态

当前重点在这些方向：

- 持久化 agent runtime
- LangGraph 工作流与工具调用
- 浏览器端 IDE 工作台
- MiniMax / Claude provider 适配
- SWE-bench Lite headless runner 与官方 harness 链路

建议先看这些文档：

- [阅读顺序](./docs/reading-guide.md)
- [项目进展](./docs/progress.md)
- [完成定义](./docs/agent-definition-of-done.md)
- [架构说明](./docs/agent-architecture.md)

## 仓库里有什么

- `apps/ide-web`
  Web IDE 外壳、provider hooks、浏览器接口和 dev server。
- `packages/core`
  核心领域模型：session、goal、plan、task、memory、tool policy。
- `packages/runtime`
  LangGraph 工作流合同、runtime 编排、应用服务。
- `packages/db`
  MySQL repository、Redis 缓存、bootstrap、checkpoint 持久化。
- `packages/tools`
  runtime 使用的内建文件/命令类工具。
- `packages/evals`
  smoke、benchmark runner、SWE-bench Lite 导出脚本。
- `docs`
  阅读顺序、深度拆解、基准测试说明、面试材料等文档。

## 本地启动

### 环境依赖

- Node.js
- `pnpm` 10.x
- Docker Desktop
- Python 3

### 1. 安装依赖

```bash
pnpm install
```

### 2. 准备环境变量

```bash
cp .env.example .env
```

至少需要配置：

- MySQL / Redis 连接信息
- 一个可用的模型 provider
  - MiniMax：`MINIMAX_API_KEY`、`MINIMAX_BASE_URL`、`MINIMAX_MODEL`
  - 或 Claude 相关环境变量

环境变量模板见：
- [.env.example](./.env.example)

### 3. 启动基础设施

```bash
pnpm infra:up
```

默认会启动：

- MySQL 8.4
- Redis 7

Compose 文件：
- [compose.yaml](./compose.yaml)

### 4. 启动 Web IDE

```bash
pnpm dev:ide-web
```

默认监听：

- `127.0.0.1:3440`

## 常用验证命令

持久化 smoke：

```bash
pnpm smoke:persistence
```

MiniMax smoke：

```bash
pnpm smoke:minimax
```

类型检查：

```bash
pnpm typecheck
```

## SWE-bench Lite 跑法

当前仓库已经内置了一个 headless runner，用来产出给官方 harness 使用的 `predictions.json`。

主要文件：

- [packages/evals/src/swebench-lite.ts](./packages/evals/src/swebench-lite.ts)
- [packages/evals/scripts/export_swebench_lite_subset.py](./packages/evals/scripts/export_swebench_lite_subset.py)
- [docs/swebench-lite.md](./docs/swebench-lite.md)

先导出一小批实例：

```bash
pnpm bench:swebench:export --count 5 --output .benchmarks/swebench-lite/instances.json
```

再跑本地 Lite runner：

```bash
LLM_PROVIDER=minimax pnpm bench:swebench:lite -- \
  --instances-file .benchmarks/swebench-lite/instances.json \
  --run-id swebench-lite-manual-1
```

然后去官方 `SWE-bench` 仓库里跑 harness：

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path /path/to/opencode/.benchmarks/swebench-lite/runs/swebench-lite-manual-1/predictions.json \
  --instance_ids <实例 id ...> \
  --max_workers 1 \
  --run_id swebench-lite-manual-1 \
  --namespace ''
```

## 推荐阅读顺序

如果你的目标是看懂项目，而不是只把它跑起来，建议按这个顺序：

1. [docs/reading-guide.md](./docs/reading-guide.md)
2. [docs/langgraph-in-project.md](./docs/langgraph-in-project.md)
3. [docs/project-deep-dive.md](./docs/project-deep-dive.md)
4. [docs/progress.md](./docs/progress.md)

## 推荐的 GitHub 项目描述

实验性 Agent IDE 与 LangGraph runtime，包含 MySQL/Redis 持久化、MiniMax/Claude provider、Web 工作台，以及 SWE-bench Lite 基准测试工具链。
