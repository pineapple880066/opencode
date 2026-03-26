# SWE-bench Lite 跑法

这份文档只关注一件事：让当前仓库先稳定跑通 `SWE-bench Lite` 的前 `5` 个实例。

这不是排行榜方案，也不是最终高分方案。当前目标只是把下面这条链路打通：

1. 导出 5 条实例
2. 为每条实例准备独立 repo 基线工作区
3. 让当前 agent headless 地跑完一轮
4. 收集 `git diff` 形成 predictions 文件
5. 交给官方 harness 评测

## 当前仓库新增的相关文件

- runner 主入口：
  - `/Users/pineapple/Desktop/opencode/packages/evals/src/swebench-lite.ts`
- runner 单测：
  - `/Users/pineapple/Desktop/opencode/packages/evals/src/swebench-lite.test.ts`
- 实例导出脚本：
  - `/Users/pineapple/Desktop/opencode/packages/evals/scripts/export_swebench_lite_subset.py`

## 为什么不走浏览器 UI，而是单独做 headless runner

benchmark 评的是 patch，不是 UI 交互体验。

如果继续从浏览器页面点按钮，会立刻遇到几个问题：

- 很难批量跑
- 很难稳定复现
- 很难关联 `instance_id -> workspace -> session -> patch`
- 很难把结果直接写成官方 harness 可读的 predictions 文件

所以这里刻意走的是：

- `instances.json`
- `headless runner`
- `predictions.json`
- `official harness`

这条批处理链。

## 依赖准备

### 1. 当前仓库自己的基础设施

当前 agent runtime 依赖：

- `MySQL`
- `Redis`
- `MiniMax API Key`

先起本地依赖：

```bash
cd /Users/pineapple/Desktop/opencode
pnpm infra:up
```

确保仓库根目录 `.env` 至少有：

```env
MINIMAX_API_KEY=...
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M2.7

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=agent_ide
MYSQL_USER=root
MYSQL_PASSWORD=change-me

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
```

### 2. 官方 SWE-bench 仓库

官方仓库当前已经浅克隆到：

- `/Users/pineapple/Desktop/benchmarks/SWE-bench`

如果你以后要手动重拉：

```bash
mkdir -p /Users/pineapple/Desktop/benchmarks
git clone --depth 1 --filter=blob:none https://github.com/SWE-bench/SWE-bench.git /Users/pineapple/Desktop/benchmarks/SWE-bench
```

然后准备 Python 环境：

```bash
cd /Users/pineapple/Desktop/benchmarks/SWE-bench
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
pip install datasets
```

如果只是想先验证 harness 本身是否可用，可以先跑 gold sanity check：

```bash
python -m swebench.harness.run_evaluation \
  --predictions_path gold \
  --max_workers 1 \
  --instance_ids sympy__sympy-20590 \
  --run_id validate-gold \
  --namespace ''
```

说明：

- `--namespace ''` 对 Apple Silicon / M-series 很重要
- 官方 README 也明确说明 `arm64` 仍然是实验性支持

## 第一步：导出 5 条 Lite 实例

回到当前仓库：

```bash
cd /Users/pineapple/Desktop/opencode
```

如果你已经激活了带 `datasets` 的 Python 环境，可以直接执行：

```bash
pnpm bench:swebench:export -- --count 5 --output .benchmarks/swebench-lite/instances.json
```

如果你想显式指定实例，可以重复传 `--instance-id`：

```bash
pnpm bench:swebench:export -- \
  --instance-id sympy__sympy-20590 \
  --instance-id sphinx-doc__sphinx-11445 \
  --output .benchmarks/swebench-lite/instances.json
```

导出脚本会写出一个 JSON array，只保留当前 runner 真正需要的字段：

- `instance_id`
- `repo`
- `base_commit`
- `problem_statement`
- `hints_text`
- `version`
- `FAIL_TO_PASS`
- `PASS_TO_PASS`

## 第二步：让当前 agent 跑这 5 条实例

直接运行：

```bash
cd /Users/pineapple/Desktop/opencode
pnpm bench:swebench:lite -- --instances-file .benchmarks/swebench-lite/instances.json --limit 5
```

runner 会自动做几件事：

1. 读取实例文件
2. 把每个 `repo` clone 到缓存目录
3. 为每个 `instance_id` 准备独立工作区，并 checkout 到 `base_commit`
4. 创建 `session`
5. 调 `runtime.langGraph.invoke(...)`
6. 收集工作区里的 `git diff`
7. 生成 `predictions.json`

默认输出目录在：

- `/Users/pineapple/Desktop/opencode/.benchmarks/swebench-lite/runs/<run_id>/`

其中会有这些文件：

- `predictions.json`
- `run-report.json`
- `instance-ids.txt`
- `workspaces/<instance_id>/...`

## 第三步：把 predictions 交给官方 harness

在官方 SWE-bench 仓库执行：

```bash
cd /Users/pineapple/Desktop/benchmarks/SWE-bench
source .venv/bin/activate
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path /Users/pineapple/Desktop/opencode/.benchmarks/swebench-lite/runs/<run_id>/predictions.json \
  --instance_ids $(tr '\n' ' ' < /Users/pineapple/Desktop/opencode/.benchmarks/swebench-lite/runs/<run_id>/instance-ids.txt) \
  --max_workers 1 \
  --run_id <run_id> \
  --namespace ''
```

如果你嫌 shell 替换麻烦，也可以把 `instance-ids.txt` 里的 5 个 ID 手工贴到命令里。

## 这条链里最重要的 3 个设计点

### 1. repo cache 和 instance workspace 分开

对应代码：

- `/Users/pineapple/Desktop/opencode/packages/evals/src/swebench-lite.ts`

关键函数：

- `ensureRepositoryCache()`
- `ensureCommitAvailable()`
- `prepareInstanceWorkspace()`

设计理由：

- 同一个 repo 可能有多个实例，直接每次从 GitHub 重新 clone 太慢
- 但多个实例不能共用同一个工作树，否则改动会互相污染

所以这里做成：

- repo 级 cache clone
- instance 级独立工作区

### 2. benchmark 不走浏览器 UI

对应代码：

- `/Users/pineapple/Desktop/opencode/packages/evals/src/swebench-lite.ts`

关键函数：

- `runSweBenchLite()`

设计理由：

- benchmark 需要稳定批处理
- 需要直接拿 patch
- 需要把实例、session、workspace、report 一起落盘

这些都不适合通过 workbench 页面驱动。

### 3. runner 单独自动批准 bash

对应代码：

- `/Users/pineapple/Desktop/opencode/packages/runtime/src/langgraph.ts`
- `/Users/pineapple/Desktop/opencode/apps/ide-web/src/bootstrap.ts`
- `/Users/pineapple/Desktop/opencode/packages/evals/src/swebench-lite.ts`

设计理由：

- `build/general` 模式下，`bash` 默认需要 approval
- 但 benchmark runner 是 headless 的，没有点击批准这一步
- 如果不显式处理，agent 在 benchmark 路径里就根本跑不了最小验证命令

所以这次不是改全局 policy，而是在 runner 启动 runtime 时显式注入：

- `toolApprovalDecider: ({ toolCall }) => toolCall.name === "bash"`

也就是说：

- 只有这个 headless benchmark 路径会自动批准 `bash`
- IDE 普通交互路径不会被偷偷放宽

## 我建议你怎么跑

不要一上来就全量 Lite。

建议顺序：

1. 先 gold sanity check，确认官方 harness 能跑
2. 再导出 5 条 Lite 实例
3. 跑 `pnpm bench:swebench:lite`
4. 看 `run-report.json` 里哪些实例是：
   - 没 patch
   - patch 空
   - tool 调用过少
   - 全程只读没改
5. 再把 predictions 喂给 official harness

## 当前已知限制

- 当前 agent 的 benchmark 能力仍然只是 baseline，不是冲榜方案
- 当前 runner 默认串行跑，没有并发调度
- 当前没有专门的 retrieval / oracle context
- 当前没有 benchmark 专用 resume / retry
- Apple Silicon 上跑官方 harness 仍然偏重，官方也写明 `arm64` 是实验性支持
