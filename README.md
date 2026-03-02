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
  - `build_semantic_graph`
  - `import_precise_index`
  - `query_semantic_graph`
  - `get_semantic_graph_stats`
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
npm run bench:index
npm run bench:index:check
npm run bench:semantic
npm run bench:semantic:check
```

## 测试

- `npm test`：运行全部自动化测试（Node test runner）
- `npm run test:watch`：监听模式，边改边测
- `npm run test:coverage`：生成覆盖率报告（实验特性）
- `npm run bench:index`：运行代码索引基准（build/refresh/query/index size）
- `npm run bench:index:check`：按 `tests/bench/code-index.baseline.json` 执行 20% 性能退化门禁
- `npm run bench:index:baseline`：重写代码索引基线（更新基准文件）
- `npm run bench:semantic`：运行语义任务基准（多跳链路命中）
- `npm run bench:semantic:check`：按 `tests/bench/code-index-semantic.baseline.json` 执行 5% 语义质量退化门禁
- `npm run bench:semantic:baseline`：重写语义质量基线
- GitHub Actions 会在 `push`/`pull_request` 自动运行测试，配置见 `.github/workflows/ci.yml`

测试文件位于 `tests/`，命名为 `*.test.js`。
代码索引检索质量回归集位于 `tests/fixtures/index-cases/`。
增量一致性回归位于 `tests/code-index-consistency.test.js`（比较 incremental/event 与 full rebuild 的查询签名）。
代码索引发布验收清单位于 `docs/code-index-release-checklist.md`。
语义评测说明位于 `docs/code-index-semantic-evaluation.md`。

## 代码索引使用建议

在 `chat` 模式中可直接下达：

- “先构建代码索引，再查找和 apply patch 相关的实现”
- “代码改完后刷新索引，再查找和增量索引相关的实现”
- “查询 index 中与 openai client 相关的文件，给我前 5 个结果”
- “刷新索引（changed_paths: [src/a.js], deleted_paths: [src/b.js]）后给我索引统计”
- “只查 `src/` 下 `javascript` 结果，并输出 explain 评分明细”
- “先构建 semantic graph，再查 `fooToken` 的 definition/reference 邻居”
- “导入 `scip.normalized.json`（mode=merge），再查询语义图”

模型会自动调用 `build_code_index` / `refresh_code_index` / `query_code_index` / `get_index_stats`。
索引存储路径为 `.clawty/index.db`（SQLite FTS5）。
`query_code_index` 支持 `path_prefix`、`language`、`explain`，并返回 `cache_hit`、`query_time_ms`、`candidate_profile` 与候选召回上限信息。`get_index_stats` 会返回查询命中率与慢查询摘要（`query_metrics`）。
符号检索支持 camelCase / snake_case 分词召回（例如查询 `user profile` 可命中 `createUserProfile` / `sync_user_profile`）。
`get_index_stats.counts` 新增 `symbol_terms` 字段，表示符号词项索引规模。
`build_semantic_graph` 会基于索引符号构建语义节点，并在 LSP 可用时补充 definition/reference 边；`query_semantic_graph` 可查看图邻居用于多跳推理。
`import_precise_index` 可导入 SCIP 归一化 JSON（`nodes` + `edges`）并以 `source=scip` 写入语义图，支持 `merge`/`replace`。
精确索引导入格式见 `docs/precise-index-import.md`。

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
- `CLAWTY_INDEX_PREPARE_CONCURRENCY`：代码索引预处理并发度（默认按 CPU 推断，最大 `16`）

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
