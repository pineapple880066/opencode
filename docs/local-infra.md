# 本地基础设施

这份文档回答一个很实际的问题：怎么在本地把这个仓库依赖的 `MySQL + Redis` 起起来，让 `smoke:minimax` 和 `smoke:persistence` 能直接跑。

## 现在仓库里有什么

仓库根目录已经有：

- `compose.yaml`
- `pnpm infra:up`
- `pnpm infra:down`
- `pnpm infra:logs`
- `pnpm infra:ps`

默认会启动：

- `MySQL 8.4`
- `Redis 7`

并且都会带：

- host 端口映射
- healthcheck
- 命名 volume 持久化

## 使用前提

你本机需要先有：

- Docker
- Docker Compose v2

你可以先检查：

```bash
docker --version
docker compose version
```

## 推荐做法

### 1. 先准备 `.env`

你可以直接从 `.env.example` 复制：

```bash
cp .env.example .env
```

当前这份 `.env` 会被两边复用：

- 应用脚本会自动加载 `.env / .env.local`
- `docker compose` 也会读取同目录下的 `.env`

最重要的几项是：

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=agent_ide
MYSQL_USER=root
MYSQL_PASSWORD=change-me

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
```

如果你还要跑 MiniMax，再补：

```env
MINIMAX_API_KEY=你的_key
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M2.7
```

### 2. 启动本地基础设施

```bash
pnpm infra:up
```

如果你改过 MySQL 配置，或者第一次启动时容器初始化失败过，先重置 volume 更稳：

```bash
pnpm infra:reset
pnpm infra:up
```

`pnpm infra:up` 现在会等待 healthcheck 通过再返回，所以更适合后面立刻接 `smoke:minimax` 或 `smoke:persistence`。

### 3. 查看状态

```bash
pnpm infra:ps
```

这里默认会走 `docker compose ps -a`，所以即使容器异常退出，你也能直接看到，而不是只看到空列表。

如果你想看日志：

```bash
pnpm infra:logs
```

### 4. 跑 smoke

先跑持久化链路：

```bash
pnpm smoke:persistence
```

再跑 MiniMax：

```bash
pnpm smoke:minimax "请为这个 agent IDE 创建一个 goal，并生成一份可执行计划"
```

### 5. 停掉基础设施

```bash
pnpm infra:down
```

## 端口和数据

默认端口：

- MySQL: `3306`
- Redis: `6379`

默认 volume：

- `agent-ide_mysql-data`
- `agent-ide_redis-data`

这意味着你 `infra:down` 之后，数据库和 Redis 数据默认还在。

如果你想连 volume 一起删：

```bash
pnpm infra:reset
```

## 常见问题

### 1. `ECONNREFUSED 127.0.0.1:3306`

通常是：

- MySQL 容器没启动
- MySQL 还没通过 healthcheck
- 端口被占用

先看：

```bash
pnpm infra:ps
pnpm infra:logs
```

### 1.1 MySQL 容器反复重启

如果 `pnpm infra:ps` 看到 MySQL 一直 `Restarting`，通常说明：

- compose 参数不兼容当前镜像版本
- 或者上一次失败启动留下了半初始化 volume

最稳的恢复方式：

```bash
pnpm infra:reset
pnpm infra:up
pnpm infra:ps
```

### 2. `ECONNREFUSED 127.0.0.1:6379`

通常是 Redis 没起来，处理方式和 MySQL 一样。

### 3. 改了 `.env` 之后为什么还是旧配置

如果容器已经创建过，部分数据库初始化参数不会自动重跑。最稳的处理是：

```bash
docker compose down -v
pnpm infra:up
```

## 为什么我这里先只放 MySQL 和 Redis

因为当前仓库里真正的运行时依赖就这两个：

- `MySQL` 是 durable state 的真相源
- `Redis` 是 summary cache / lease / 后续队列能力的热路径

MiniMax 不是容器内依赖，而是外部模型 provider，所以不应该被硬塞进 compose 里。
