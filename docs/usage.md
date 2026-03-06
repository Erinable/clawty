# Clawty 使用手册

这份文档面向“每天要写代码、要排查问题、要保证质量”的使用场景。

## 1. 快速开始

### 1.1 环境准备

```bash
npm install
cp .env.example .env
```

在 `.env` 至少设置：

```bash
OPENAI_API_KEY=sk-...
```

### 1.2 初始化项目分析能力

```bash
node src/index.js init
```

### 1.3 跑一条任务验证链路

```bash
node src/index.js run "读取 package.json 并总结项目结构"
```

### 1.4 进入多轮模式

```bash
node src/index.js chat
```

## 2. 公共命令（与 CLI 帮助一致）

> 以 `node src/index.js --help` 和各子命令 `--help` 为准。

### 2.1 `chat`

```bash
node src/index.js chat
```

- 多轮交互模式。
- 输入 `exit` / `quit` 可退出。

### 2.2 `run [message..]`

```bash
node src/index.js run "修复 monitor 相关失败测试"
```

- 单次任务模式。
- 也支持省略 `run`，直接把文本当任务输入：

```bash
node src/index.js "帮我解释 src/index.js 的命令分发"
```

### 2.3 `init`

```bash
node src/index.js init --help
```

常用：

```bash
node src/index.js init
node src/index.js init --include-vector
node src/index.js init --no-doctor --no-semantic
node src/index.js init --json
```

可用参数：

- `--no-doctor`
- `--no-syntax`
- `--no-semantic`
- `--include-vector`
- `--vector-layer <base|delta>`
- `--max-files <n>`
- `--max-file-size-kb <n>`
- `--semantic-seed-lang-filter <v>`
- `--json`

### 2.4 `doctor`

```bash
node src/index.js doctor
node src/index.js doctor --json
```

- 诊断 Node、API key、工作区、git/LSP/tree-sitter、SQLite 可写性等。
- `--json` 方便 CI 和脚本消费。

### 2.5 `watch-index`

```bash
node src/index.js watch-index --help
```

快速参数（help 展示）：

- `--interval-ms <n>`
- `--no-vector`
- `--quiet`

高级参数（仍然支持，建议在 `.clawty/config.json` 或 env 中管理）：

- 批量与防抖：`max_batch_size`、`debounce_ms`
- 反压：`backpressure_enabled`、`backpressure_threshold_ratio`、`backpressure_debounce_ms`
- DB 重试：`db_retry_budget`、`db_retry_backoff_ms`、`db_retry_backoff_max_ms`
- hash 去重：`hash_skip_enabled`、`hash_init_max_files`
- 刷新范围：`include_syntax`、`include_semantic`、`include_vector`、`vector_layer`

示例：

```bash
node src/index.js watch-index --interval-ms 1000
node src/index.js watch-index --max-batch-size 200 --debounce-ms 500
node src/index.js watch-index --backpressure-threshold-ratio 2 --backpressure-debounce-ms 120
node src/index.js watch-index --include-vector=true --vector-layer=delta
```

### 2.6 `config show`

```bash
node src/index.js config show
node src/index.js config show --json
```

- 输出生效配置（敏感字段已脱敏）。
- `config path` / `config validate` 已从公共 CLI 移除，使用 `doctor --json`。

### 2.7 `memory`

```bash
node src/index.js memory --help
```

可用子命令：

```bash
node src/index.js memory search "retry timeout" --top-k 5
node src/index.js memory search "retry timeout" --top-k 5 --explain
node src/index.js memory stats
```

可用参数：

- `--json`
- `--explain`（仅 `search`）
- `--top-k <n>`
- `--scope <project|global|project+global>`

说明：`memory inspect/feedback/prune/reindex` 已从公共 CLI 移除。

### 2.8 `monitor [report]`

```bash
node src/index.js monitor
node src/index.js monitor report --window-hours 24 --json
node src/index.js monitor --watch --interval-ms 5000 --json
```

可用参数：

- `--json`
- `--window-hours <n>`（`0 < n <= 720`）
- `--watch`
- `--interval-ms <n>`（`500 - 60000`）

说明：`monitor metrics` / `monitor tuner` 已从公共 CLI 移除。

### 2.9 `mcp-server`

```bash
node src/index.js mcp-server --help
```

常用：

```bash
# 默认按配置启动（默认 stdio）
node src/index.js mcp-server

# 快速 HTTP 调试
node src/index.js mcp-server --port 8765
```

help 展示参数：

- `--workspace <path>`
- `--port <n>`
- `--log-path <path>`

高级参数（支持但隐藏）：

- `--transport <stdio|http>`
- `--host <host>`
- `--toolset <analysis|ops|edit-safe|all>`
- `--expose-low-level`

默认工具集策略：

- 默认：`analysis + ops`
- `reindex_codebase` 需启用 `edit-safe` 或 `all`
- 低层工具需显式 `--expose-low-level`

## 3. 推荐工作流

### 工作流 A：第一次接手仓库

```bash
node src/index.js init
node src/index.js run "梳理项目模块边界并标出核心入口"
node src/index.js chat
```

### 工作流 B：高频改动期间保持索引新鲜

```bash
node src/index.js watch-index --interval-ms 1000
```

在另一个终端继续：

```bash
node src/index.js run "基于当前改动评估回归风险"
```

### 工作流 C：上线前做最小门禁

```bash
npm run lint
npm run contract:check
npm run typecheck
npm test
npm run metrics:check
```

## 4. 配置与环境变量

配置优先级（高 -> 低）：

1. 系统环境变量
2. `.env`
3. `.clawty/config.json`（兼容旧路径 `clawty.config.json`）
4. `~/.clawty/config.json`
5. 内置默认值

配置示例：

- [clawty.config.example.json](../clawty.config.example.json)
- [.env.example](../.env.example)

最常用环境变量：

- `OPENAI_API_KEY`
- `CLAWTY_MODEL`
- `OPENAI_BASE_URL`
- `CLAWTY_WORKSPACE_ROOT`
- `CLAWTY_TOOL_TIMEOUT_MS`
- `CLAWTY_MAX_TOOL_ITERATIONS`
- `CLAWTY_WATCH_INCLUDE_VECTOR`
- `CLAWTY_LOG_LEVEL`
- `CLAWTY_MCP_TRANSPORT` / `CLAWTY_MCP_PORT`

## 5. 常见问题

### Q1：回答像没看到最新改动

优先检查：

1. 是否执行过 `init`。
2. 是否在持续改动时开启了 `watch-index`。
3. 是否在正确的项目根目录运行命令。

### Q2：LSP 不可用

- 不会阻塞使用，系统会回退到索引链路。
- 如需更强定义/引用导航，安装并配置 `typescript-language-server`。

### Q3：MCP 客户端看不到想要的工具

- 先看当前 toolset 是否包含该工具。
- `reindex_codebase` 不是默认工具。
- 低层原子工具默认不公开，需要 `--expose-low-level`。

## 6. 相关文档

- 文档总览：[README.md](./README.md)
- 项目阶段状态：[project-status.md](./project-status.md)
- 架构边界：[maintainer-architecture.md](./maintainer-architecture.md)
- 维护流程：[maintenance-workflow.md](./maintenance-workflow.md)
