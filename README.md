# Clawty CLI MVP

一个可本地运行的 AI 编程 CLI 最小版本。

## 功能

- `chat`：多轮对话模式
- `run "<任务>"`：单次任务执行模式
- 模型可调用本地工具：
  - `read_file`
  - `write_file`
  - `run_shell`
  - `apply_patch`
  - `build_code_index`
  - `refresh_code_index`
  - `query_code_index`
  - `get_index_stats`
  - `lsp_definition`
  - `lsp_references`
  - `lsp_workspace_symbols`
  - `lsp_health`
- 默认工作目录沙箱（禁止访问工作区外路径）
- 常见危险命令拦截（如 `rm -rf`, `sudo`）

## 快速开始

1. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，至少填入：

```bash
OPENAI_API_KEY=sk-...
```

2. 运行 CLI

```bash
node src/index.js --help
node src/index.js chat
node src/index.js run "读取 package.json 并总结这个项目"
```

## 命令

```bash
node src/index.js chat
node src/index.js run "your task"
node src/index.js config show
node src/index.js --help
npm test
npm run test:coverage
```

## 测试

- `npm test`：运行全部自动化测试（Node test runner）
- `npm run test:watch`：监听模式，边改边测
- `npm run test:coverage`：生成覆盖率报告（实验特性）
- GitHub Actions 会在 `push`/`pull_request` 自动运行测试，配置见 `.github/workflows/ci.yml`

测试文件位于 `tests/`，命名为 `*.test.js`。

## 代码索引使用建议

在 `chat` 模式中可直接下达：

- “先构建代码索引，再查找和 apply patch 相关的实现”
- “代码改完后刷新索引，再查找和增量索引相关的实现”
- “查询 index 中与 openai client 相关的文件，给我前 5 个结果”
- “刷新索引（changed_paths: [src/a.js], deleted_paths: [src/b.js]）后给我索引统计”
- “只查 `src/` 下 `javascript` 结果，并输出 explain 评分明细”

模型会自动调用 `build_code_index` / `refresh_code_index` / `query_code_index` / `get_index_stats`。
索引存储路径为 `.clawty/index.db`（SQLite FTS5）。

## LSP 语义检索（TS/JS）

先安装 TypeScript LSP（可选但推荐）：

```bash
npm i -g typescript typescript-language-server
```

在 `chat` 模式中可直接下达：

- “对 `src/tools.js` 第 20 行做 definition 跳转”
- “查这个符号的 references（不含声明）”
- “搜索 workspace symbols: runTool”
- “检查 lsp health（startup_check=true）”

LSP 不可用时，工具会自动回退到代码索引检索结果。

## 可配置项

- `OPENAI_API_KEY`：必填
- `CLAWTY_MODEL`：默认 `gpt-4.1-mini`
- `OPENAI_BASE_URL`：默认 `https://api.openai.com/v1`
- `CLAWTY_WORKSPACE_ROOT`：默认当前目录
- `CLAWTY_TOOL_TIMEOUT_MS`：工具超时，默认 `120000`
- `CLAWTY_MAX_TOOL_ITERATIONS`：工具调用最大轮次，默认 `8`
- `CLAWTY_LSP_ENABLED`：默认 `true`
- `CLAWTY_LSP_TIMEOUT_MS`：默认 `5000`
- `CLAWTY_LSP_MAX_RESULTS`：默认 `100`
- `CLAWTY_LSP_TS_CMD`：默认 `typescript-language-server --stdio`

## 配置系统

支持两种配置输入：

1. 配置文件：`clawty.config.json`（或 `.clawty/config.json`）  
2. 环境变量：`.env` 和系统环境变量

优先级（高 -> 低）：

1. 系统环境变量
2. `.env`
3. `clawty.config.json` / `.clawty/config.json`
4. 内置默认值

你可以通过下面命令查看最终生效配置（API Key 会脱敏）：

```bash
node src/index.js config show
```

可参考示例文件：`clawty.config.example.json`。

## 说明

- 当前是 MVP，目标是先跑通“模型 + 工具调用 + 基础安全约束”的闭环。
- 当前已支持代码索引：先构建索引，再按关键词检索相关文件与片段。
- 后续可继续扩展：增量索引、Git 工作流、测试驱动修复、会话记忆等能力。
