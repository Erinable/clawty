# Clawty CLI MVP

一个可本地运行的 AI 编程 CLI 最小版本。

## 功能

- `chat`：多轮对话模式
- `run "<任务>"`：单次任务执行模式
- `watch-index`：监听文件变更并自动刷新索引
- 模型可调用本地工具：
  - `read_file`
  - `write_file`
  - `run_shell`
  - `apply_patch`
  - `build_code_index`
  - `refresh_code_index`
  - `query_code_index`
  - `get_index_stats`
  - `build_syntax_index`
  - `refresh_syntax_index`
  - `query_syntax_index`
  - `get_syntax_index_stats`
  - `build_semantic_graph`
  - `refresh_semantic_graph`
  - `import_precise_index`
  - `query_semantic_graph`
  - `query_hybrid_index`
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
node src/index.js watch-index
node src/index.js --help
npm run watch:index
npm test
npm run test:coverage
npm run coverage:check
npm run bench:index
npm run bench:index:check
npm run bench:semantic
npm run bench:semantic:check
npm run bench:graph
npm run bench:graph:check
npm run bench:graph:refresh
npm run bench:graph:refresh:check
npm run precise:check
npm run precise:check:fixture
```

## 测试

- `npm test`：运行全部自动化测试（Node test runner）
- `npm run test:watch`：监听模式，边改边测
- `npm run test:coverage`：生成覆盖率报告（实验特性）
- `npm run coverage:check`：执行覆盖率硬门禁（全局阈值 + 核心文件阈值）
  - 可选环境变量：`COVERAGE_MIN_LINE` / `COVERAGE_MIN_BRANCH` / `COVERAGE_MIN_FUNCS`
  - 可选核心文件覆盖率覆盖：`COVERAGE_CORE_LINE_THRESHOLDS=\"code-index.js=90,semantic-graph.js=75\"`
- `npm run bench:index`：运行代码索引基准（build/refresh/query/index size）
- `npm run bench:index:check`：按 `tests/bench/code-index.baseline.json` 执行 20% 性能退化门禁
- `npm run bench:index:baseline`：重写代码索引基线（更新基准文件）
- `npm run bench:semantic`：运行语义任务基准（多跳链路命中）
- `npm run bench:semantic:check`：按 `tests/bench/code-index-semantic.baseline.json` 执行 5% 语义质量退化门禁
- `npm run bench:semantic:baseline`：重写语义质量基线
- `npm run bench:graph`：运行语义图基准（`query_semantic_graph` 检索质量）
- `npm run bench:graph:check`：按 `tests/bench/semantic-graph.baseline.json` 执行 5% 语义图质量退化门禁
- `npm run bench:graph:baseline`：重写语义图质量基线
- `npm run bench:graph:refresh`：运行语义图增量刷新一致性基准（event vs full）
- `npm run bench:graph:refresh:check`：按 `tests/bench/semantic-graph-refresh.baseline.json` 执行 2% 增量一致性退化门禁
- `npm run bench:graph:refresh:baseline`：重写语义图增量刷新基线
- `npm run precise:check`：校验 `artifacts/scip.normalized.json`（文件缺失时跳过，不报错）
- `npm run precise:check:fixture`：校验内置精确索引夹具格式（CI 强制执行）
- `npm run precise:import`：一键执行 `build_code_index + import_precise_index`（replace 模式）
- GitHub Actions 会在 `push`/`pull_request` 自动运行测试，配置见 `.github/workflows/ci.yml`

测试文件位于 `tests/`，命名为 `*.test.js`。
代码索引检索质量回归集位于 `tests/fixtures/index-cases/`。
增量一致性回归位于 `tests/code-index-consistency.test.js`（比较 incremental/event 与 full rebuild 的查询签名）。
代码索引发布验收清单位于 `docs/code-index-release-checklist.md`。
语义评测说明位于 `docs/code-index-semantic-evaluation.md`。
主流方案对齐路线图位于 `docs/code-index-mainstream-roadmap.md`。
语法索引说明位于 `docs/syntax-index.md`。
发布清单已覆盖 `query_syntax_index` 与 `semantic -> syntax -> index` 回退验收门禁。

## 代码索引使用建议

在 `chat` 模式中可直接下达：

- “先构建代码索引，再查找和 apply patch 相关的实现”
- “代码改完后刷新索引，再查找和增量索引相关的实现”
- “查询 index 中与 openai client 相关的文件，给我前 5 个结果”
- “刷新索引（changed_paths: [src/a.js], deleted_paths: [src/b.js]）后给我索引统计”
- “只查 `src/` 下 `javascript` 结果，并输出 explain 评分明细”
- “先构建 syntax index，再看 import/call 结构统计”
- “代码改完后刷新 syntax index（changed_paths: [src/a.js]）并返回最新 stats”
- “查询 syntax index（query: syntaxMain）并返回结构邻居”
- “先构建 semantic graph，再查 `fooToken` 的 definition/reference 邻居”
- “代码改完后刷新 semantic graph（changed_paths/deleted_paths）再查多跳邻居”
- “用 `query_hybrid_index` 融合 semantic/syntax/index，返回重排后的 Top5”
- “启用 `query_hybrid_index` 的 embedding rerank（enable_embedding=true）再返回 Top5”
- “导入 `scip.normalized.json`（mode=merge），再查询语义图”

模型会自动调用 `build_code_index` / `refresh_code_index` / `query_code_index` / `get_index_stats`。
索引存储路径为 `.clawty/index.db`（SQLite FTS5）。
`query_code_index` 支持 `path_prefix`、`language`、`explain`，并返回 `cache_hit`、`query_time_ms`、`candidate_profile` 与候选召回上限信息。`get_index_stats` 会返回查询命中率与慢查询摘要（`query_metrics`）。
符号检索支持 camelCase / snake_case 分词召回（例如查询 `user profile` 可命中 `createUserProfile` / `sync_user_profile`）。
`get_index_stats.counts` 新增 `symbol_terms` 字段，表示符号词项索引规模。
`build_syntax_index` / `refresh_syntax_index` 会基于 `files` 表提取 import/call 结构边（当前 provider：`tree-sitter-skeleton`），并写入同一数据库。
可选 `parser_provider`：`auto`（默认）/ `skeleton` / `tree-sitter`；当 `tree-sitter` 不可用时默认回退到 `skeleton`（`parser_strict=true` 可改为失败）。
`auto` 策略会优先对 `TS/JS/Python/Go` 使用 tree-sitter，其它语言走 skeleton。
`query_syntax_index` 按 symbol/path 关键词返回结构邻居（outgoing imports/calls、incoming importers/callers）。
`get_syntax_index_stats` 返回语法索引规模、Top callers、Top imported targets 及最近一次构建信息。
`build_semantic_graph` 会基于索引符号构建语义节点，并在 LSP 可用时补充 definition/reference 边；`query_semantic_graph` 可查看图邻居用于多跳推理。
`build_semantic_graph` / `refresh_semantic_graph` 支持 `semantic_seed_lang_filter`（例如 `javascript,python,go`），默认 `*`（不过滤）。
`refresh_semantic_graph` 支持事件模式增量刷新（`changed_paths` / `deleted_paths`）；未提供事件路径时会回退全量构建。
当 syntax index 可用时，`build_semantic_graph` 会自动摄取 syntax import/call 边（`source=syntax`）作为结构先验。
`import_precise_index` 可导入 SCIP 归一化 JSON（`nodes` + `edges`）并以 `source=scip` 写入语义图，支持 `merge`/`replace`。
`query_semantic_graph` 会对同实体结果去重，并按来源优先级返回（`scip > lsif > lsp > syntax > index_seed > lsp_anchor`）。
`query_semantic_graph` 返回 `language_distribution`（`scanned_candidates` / `deduped_candidates` / `returned_seeds`），用于观察召回语言偏置。
`query_hybrid_index` 会联合 `semantic + syntax + index` 候选并做轻量重排，支持 `path_prefix` 与 `explain`。
可选启用 embedding 第二阶段重排（`enable_embedding` / `embedding_top_k` / `embedding_weight` / `embedding_model`），默认关闭。
返回 `sources.embedding` 观测字段（`status_code` / `error_code` / `latency_ms` / `rank_shift_count` / `top1_changed`），便于稳定性与效果追踪。
`query_semantic_graph` 支持 `max_hops`（默认 `1`）与 `per_hop_limit`，当 `max_hops > 1` 时每个 seed 会返回 `multi_hop` 路径展开结果（含 `path_score` 与质量因子）。
`build_semantic_graph` 默认启用“精确优先”：若检测到 `artifacts/scip.normalized.json` 等候选文件，会优先执行 `replace` 导入；不可用时自动回退到 LSP/index 建图。
`query_semantic_graph` 在语义图为空时会按 `query_syntax_index -> query_code_index` 顺序回退，保证可用性。
`get_semantic_graph_stats` 返回 `source_mix` 与 `precise_freshness`，可观测精确来源占比与产物时效。
精确索引导入格式见 `docs/precise-index-import.md`。

## 实时索引监听（watch-index）

`watch-index` 会定时扫描工作区并自动执行：

1. `refresh_code_index`
2. `refresh_syntax_index`（可关闭）
3. `refresh_semantic_graph`（可关闭）

常用命令：

```bash
node src/index.js watch-index
node src/index.js watch-index --interval-ms 1000 --max-batch-size 200
node src/index.js watch-index --debounce-ms 500 --hash-init-max-files 3000
node src/index.js watch-index --no-semantic --quiet
npm run watch:index
```

常用参数：

- `--interval-ms <n>`：轮询间隔（毫秒）
- `--max-files <n>`：最大跟踪文件数
- `--max-batch-size <n>`：单次增量刷新批大小
- `--debounce-ms <n>`：事件抖动合并窗口（毫秒）
- `--hash-skip-enabled <bool>`：内容 hash 不变时跳过刷新
- `--hash-init-max-files <n>`：启动时初始化 hash 缓存的文件上限
- `--no-build-on-start`：跳过启动时全量构建
- `--no-hash-skip`：关闭 hash skip
- `--no-syntax`：关闭 syntax 刷新
- `--no-semantic`：关闭 semantic 刷新
- `--quiet`：关闭日志输出

watch 结果会返回 `watch_metrics`（如 `queue_depth`、`index_lag_ms`、`dropped_by_hash`）用于观测增量调度效果。

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
- `CLAWTY_EMBEDDING_ENABLED`：是否开启 hybrid embedding 重排，默认 `false`
- `CLAWTY_EMBEDDING_MODEL`：embedding 模型，默认 `text-embedding-3-small`
- `CLAWTY_EMBEDDING_TOP_K`：embedding 重排候选数，默认 `15`
- `CLAWTY_EMBEDDING_WEIGHT`：embedding 融合权重（0-1），默认 `0.25`
- `CLAWTY_EMBEDDING_TIMEOUT_MS`：embedding 请求超时，默认 `15000`
- `CLAWTY_EMBEDDING_API_KEY`：可选独立 key，未设置时回退 `OPENAI_API_KEY`
- `CLAWTY_EMBEDDING_BASE_URL`：可选独立 endpoint，未设置时回退 `OPENAI_BASE_URL`
- `CLAWTY_SEMANTIC_SEED_LANG_FILTER`：语义图 seed 语言过滤，默认 `*`（不过滤）
- `CLAWTY_PRECISE_STALE_AFTER_MINUTES`：精确索引新鲜度阈值（分钟），默认 `1440`
- `CLAWTY_INDEX_PREPARE_CONCURRENCY`：代码索引预处理并发度（默认按 CPU 推断，最大 `16`）
- `CLAWTY_WATCH_INTERVAL_MS`：watch 轮询间隔（毫秒），默认 `2000`
- `CLAWTY_WATCH_MAX_FILES`：watch 最大跟踪文件数，默认 `20000`
- `CLAWTY_WATCH_MAX_BATCH_SIZE`：watch 增量批大小，默认 `300`
- `CLAWTY_WATCH_DEBOUNCE_MS`：watch 队列防抖窗口（毫秒），默认 `500`
- `CLAWTY_WATCH_HASH_SKIP_ENABLED`：watch 是否启用 hash skip，默认 `true`
- `CLAWTY_WATCH_HASH_INIT_MAX_FILES`：watch 启动 hash 缓存文件上限，默认 `2000`
- `CLAWTY_WATCH_BUILD_ON_START`：watch 启动时是否先全量构建，默认 `true`
- `CLAWTY_WATCH_INCLUDE_SYNTAX`：watch 是否刷新 syntax index，默认 `true`
- `CLAWTY_WATCH_INCLUDE_SEMANTIC`：watch 是否刷新 semantic graph，默认 `true`
- `CLAWTY_WATCH_SEMANTIC_INCLUDE_DEFINITIONS`：watch 语义刷新是否包含 definition，默认 `false`
- `CLAWTY_WATCH_SEMANTIC_INCLUDE_REFERENCES`：watch 语义刷新是否包含 references，默认 `false`
- `CLAWTY_WATCH_QUIET`：watch 是否静默模式，默认 `false`

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
