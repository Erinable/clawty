# Clawty CLI

一个本地运行的 AI 编程助手 CLI：支持多轮对话、工具调用、代码索引检索、增量刷新、长期记忆和 MCP 服务。

如果你第一次接触本项目，先看“5 分钟上手”，不要先看全部高级参数。

## 这项目解决什么问题

Clawty 主要解决三件事：

1. 让 AI 在本地仓库里“看得见代码结构”，不只靠纯文本猜测。
2. 让 AI 在你的安全边界内执行工具（读写文件、运行命令、打补丁）。
3. 让索引、记忆、观测数据形成闭环，支持持续迭代而不是一次性问答。

典型场景：

- 新接手仓库：快速定位实现入口和调用链。
- 改动后回归：基于增量上下文分析受影响范围。
- 日常开发：让 AI 辅助改代码、跑命令、生成补丁。

## 5 分钟上手

### 1) 前置要求

- Node.js 22+
- 可用的 `OPENAI_API_KEY`

### 2) 安装依赖

```bash
npm install
```

### 3) 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，至少填入：

```bash
OPENAI_API_KEY=sk-...
```

### 4) 先看帮助

```bash
node src/index.js --help
```

如果你已全局安装/链接了 `clawty`，也可以直接用：

```bash
clawty --help
```

### 5) 初始化仓库索引（推荐）

```bash
node src/index.js init
```

### 6) 开始使用

```bash
# 单次任务
node src/index.js run "读取 package.json 并总结这个项目"

# 多轮对话
node src/index.js chat
```

## 推荐使用流程（新用户）

1. `init` 建立基础索引（code/syntax/semantic）。
2. `run` 先做一个小任务，确认工具权限和配置正常。
3. `chat` 进入连续协作模式。
4. 代码频繁变动时开启 `watch-index`，保持索引新鲜。

## 命令速查

### CLI 命令

| 命令 | 作用 | 常用示例 |
| --- | --- | --- |
| `chat` | 多轮交互开发 | `node src/index.js chat` |
| `run [message..]` | 单次执行任务 | `node src/index.js run "修复这个测试"` |
| `init` | 初始化仓库分析能力 | `node src/index.js init --include-vector` |
| `doctor` | 诊断配置和依赖 | `node src/index.js doctor --json` |
| `watch-index` | 实时监听并增量刷新索引 | `node src/index.js watch-index --interval-ms 1000` |
| `config show` | 查看生效配置（脱敏） | `node src/index.js config show` |
| `memory search/stats` | 长期记忆检索与统计 | `node src/index.js memory search "auth retry" --top-k 5` |
| `monitor report` | 查看 metrics/tuner 报表 | `node src/index.js monitor report` |
| `mcp-server` | 启动 MCP 服务 | `node src/index.js mcp-server --port 8765` |

### 常用 npm 脚本

| 命令 | 作用 |
| --- | --- |
| `npm test` | 运行全部测试 |
| `npm run lint` | 语法门禁 |
| `npm run contract:check` | 模块导出契约检查 |
| `npm run typecheck` | TypeScript `checkJs` 静态检查 |
| `npm run test:coverage` | 覆盖率报告 |
| `npm run metrics:report` | 生成指标报表 |
| `npm run metrics:check` | 指标阈值检查 |
| `npm run watch:index` | 启动 watch-index |
| `npm run build:bin` | 构建单文件二进制（实验） |

## 核心能力（人话版）

### 1) 检索能力不是单一索引

- Code Index：关键词/符号检索（SQLite FTS5）
- Syntax Index：import/call 结构关系
- Semantic Graph：定义/引用/多跳邻接
- Vector Index：语义向量召回（base/delta）
- Hybrid：融合多路结果并重排

### 2) 自动增量上下文

`chat/run` 会默认注入当前工作区的 `changed_paths + git diff`，减少“没看到最新改动”的情况。

### 3) LSP 可用时优先语义导航

支持 `lsp_definition` / `lsp_references` / `lsp_workspace_symbols` / `lsp_health`。
LSP 不可用时会自动回退到索引链路。

### 4) 长期记忆

支持跨会话经验沉淀与检索（project/global 作用域），默认在会话中自动注入高相关经验。

### 5) 可观测与门禁

- 运行日志：`.clawty/logs/runtime.log`
- 指标落盘：`.clawty/metrics/*.jsonl`
- 可用 `metrics:report` 和 `metrics:check` 做质量门禁

### 6) MCP 服务

支持 `stdio/http` 传输（推荐配置优先），用于把能力暴露给外部 MCP 客户端。

## 安全边界

默认内置两层保护：

1. 工作区路径沙箱：禁止访问工作区外路径。
2. 危险命令拦截：拦截高风险 shell 命令（如 `rm -rf`、`sudo`）。

建议：在 CI/共享环境下显式设置 `CLAWTY_WORKSPACE_ROOT`，避免越界访问风险。

## 配置（先掌握这几项）

完整配置项很多，先理解最常用的 10 个：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 无 | 必填 |
| `CLAWTY_MODEL` | `gpt-4.1-mini` | 主模型 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API 地址 |
| `CLAWTY_WORKSPACE_ROOT` | 当前目录 | 工作区根目录 |
| `CLAWTY_TOOL_TIMEOUT_MS` | `120000` | 工具超时 |
| `CLAWTY_MAX_TOOL_ITERATIONS` | `8` | 单轮工具循环上限 |
| `CLAWTY_AGENT_INCREMENTAL_CONTEXT_ENABLED` | `true` | 是否注入 git 增量上下文 |
| `CLAWTY_EMBEDDING_ENABLED` | `false` | 是否启用 embedding 重排 |
| `CLAWTY_MEMORY_ENABLED` | `true` | 是否启用长期记忆 |
| `CLAWTY_WATCH_INCLUDE_VECTOR` | `false` | watch 时是否刷新向量索引 |

配置优先级（高 -> 低）：

1. 系统环境变量
2. `.env`
3. 项目配置 `.clawty/config.json`（兼容 `clawty.config.json`）
4. 全局配置 `~/.clawty/config.json`
5. 内置默认值

示例配置文件见：[clawty.config.example.json](clawty.config.example.json)。

## 常见任务示例

```bash
# 1) 首次初始化
node src/index.js init

# 2) 代码改完后刷新索引
node src/index.js watch-index --interval-ms 1000

# 3) 查看当前配置和健康状态
node src/index.js config show
node src/index.js doctor --json

# 4) 查看记忆检索解释
node src/index.js memory search "timeout retry" --top-k 5 --explain

# 5) 启动 MCP HTTP 服务
node src/index.js mcp-server --port 8765
```

## 开发与发布检查（建议顺序）

```bash
npm run lint
npm run contract:check
npm run typecheck
npm test
npm run metrics:report
npm run metrics:check
```

## 文档导航（按需深入）

- 使用手册（推荐先看）：[docs/usage.md](docs/usage.md)
- 语法索引说明：[docs/syntax-index.md](docs/syntax-index.md)
- 精确索引导入：[docs/precise-index-import.md](docs/precise-index-import.md)
- Hybrid 回放评测：[docs/hybrid-replay-evaluation.md](docs/hybrid-replay-evaluation.md)
- Hybrid 降级处置：[docs/hybrid-degrade-runbook.md](docs/hybrid-degrade-runbook.md)
- SQLite 同步风险处置：[docs/db-sync-risk-runbook.md](docs/db-sync-risk-runbook.md)
- 发布清单：[docs/code-index-release-checklist.md](docs/code-index-release-checklist.md)

## 项目结构（给开发者）

```text
src/
  index.js                # CLI 入口
  agent.js                # Agent 循环编排
  tools.js                # 工具总线
  code-index.js           # 代码索引
  syntax-index.js         # 语法索引
  semantic-graph.js       # 语义图
  vector-index.js         # 向量索引
  mcp-server.js           # MCP 服务
tests/                    # 自动化测试
scripts/                  # 维护脚本
docs/                     # 详细文档和 runbook
```

## FAQ（高频问题）

### 1) 为什么 AI 有时像“没看到最新代码”？

优先检查：

1. 是否刚改完代码但未刷新索引。
2. 是否开启了 `watch-index`。
3. 当前目录是否就是目标仓库根目录。

### 2) LSP 不可用怎么办？

可以先继续使用，Clawty 会回退到索引检索。若要提升语义导航质量，再安装并配置 `typescript-language-server`。

### 3) watch-index 变慢怎么办？

先调这三个参数：

1. 提高 `--interval-ms`
2. 降低 `--max-batch-size`
3. 临时关闭 `--include-vector`

### 4) 哪里看运行日志？

- 主日志：`.clawty/logs/runtime.log`
- MCP 日志：`.clawty/logs/mcp-server.log`

---

如果你在 README 里仍找不到想要的信息，优先去 [docs/usage.md](docs/usage.md)；它按真实开发流程组织，比参数字典更实用。
