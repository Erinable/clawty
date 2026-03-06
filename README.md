# Clawty CLI

本项目是一个本地运行的 AI 编程助手 CLI，核心能力包括：

- 本地代码理解（code/syntax/semantic/vector/hybrid）
- 安全工具执行（文件读写、命令执行、补丁应用）
- 增量索引刷新（`watch-index`）
- 长期记忆检索与写回（`memory`）
- 指标观测与健康诊断（`monitor` / `doctor`）
- 对外 MCP 服务（`mcp-server`）

## 快速开始（5 分钟）

### 1) 前置要求

- Node.js `22+`
- 可用的 `OPENAI_API_KEY`

### 2) 安装和配置

```bash
npm install
cp .env.example .env
```

编辑 `.env`，至少设置：

```bash
OPENAI_API_KEY=sk-...
```

### 3) 初始化索引

```bash
node src/index.js init
```

### 4) 运行一次任务

```bash
node src/index.js run "读取 package.json 并总结这个项目"
```

### 5) 进入多轮协作

```bash
node src/index.js chat
```

## 公共命令总览

以 `node src/index.js --help` 为准：

| 命令 | 作用 | 常用示例 |
| --- | --- | --- |
| `chat` | 多轮会话模式 | `node src/index.js chat` |
| `run [message..]` | 单次任务执行 | `node src/index.js run "fix tests"` |
| `init` | 一键预检 + 索引引导初始化 | `node src/index.js init --include-vector` |
| `doctor` | 环境与依赖健康检查 | `node src/index.js doctor --json` |
| `watch-index` | 文件变更增量刷新索引 | `node src/index.js watch-index --interval-ms 1000` |
| `config show` | 查看生效配置（脱敏） | `node src/index.js config show --json` |
| `memory search/stats` | 记忆检索与统计 | `node src/index.js memory search "retry" --top-k 5` |
| `monitor [report]` | metrics+tuner 报表 | `node src/index.js monitor --window-hours 24 --json` |
| `mcp-server` | 启动 MCP 服务 | `node src/index.js mcp-server --port 8765` |

## MCP 快速启动

```bash
# 默认 stdio（推荐优先使用配置）
node src/index.js mcp-server

# 快速 HTTP 调试
node src/index.js mcp-server --port 8765
```

- HTTP 健康检查：`GET /healthz`
- 默认工具集：`analysis + ops`
- `reindex_codebase` 需要 `edit-safe` toolset
- 原子底层工具需显式 `--expose-low-level`

## 配置优先级（高 -> 低）

1. 系统环境变量
2. `.env`
3. 项目配置 `.clawty/config.json`（兼容旧路径 `clawty.config.json`）
4. 全局配置 `~/.clawty/config.json`
5. 内置默认值

示例配置见 [clawty.config.example.json](clawty.config.example.json)。

## 安全边界

默认内置两层保护：

1. 工作区路径沙箱：禁止访问工作区外路径。
2. 危险命令拦截：拦截高风险 shell 命令（例如 `rm -rf`、`sudo`）。

建议在 CI 或共享环境显式设置 `CLAWTY_WORKSPACE_ROOT`。

## 常用开发检查

```bash
npm run lint
npm run contract:check
npm run typecheck
npm test
npm run metrics:check
npm run bench:hybrid:replay:suite
```

## 文档导航

- 使用手册（建议先看）：[docs/usage.md](docs/usage.md)
- 文档总览与阅读顺序：[docs/README.md](docs/README.md)
- 项目阶段状态：[docs/project-status.md](docs/project-status.md)
- 架构边界（维护者）：[docs/maintainer-architecture.md](docs/maintainer-architecture.md)
- 维护流程（文档/测试/门禁）：[docs/maintenance-workflow.md](docs/maintenance-workflow.md)
- 发布检查清单：[docs/code-index-release-checklist.md](docs/code-index-release-checklist.md)

## 目录结构

```text
src/
  index.js                 # CLI 入口
  agent.js                 # Agent 主循环
  tools.js                 # 工具总线
  code-index.js            # 关键词/符号索引
  syntax-index.js          # 结构索引
  semantic-graph.js        # 语义图
  vector-index.js          # 向量索引
  mcp-server.js            # MCP 服务装配
tests/                     # 自动化测试
docs/                      # 用户手册、维护文档、runbook、评测清单
```
