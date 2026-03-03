# Clawty CLI MVP

一个可本地运行的 AI 编程 CLI 最小版本。

## 功能

- `chat`：多轮对话模式
- `run "<任务>"`：单次任务执行模式
- `init`：一键初始化新仓库分析流程（doctor + code/syntax/semantic，可选 vector）
- `doctor`：本地环境与依赖健康诊断（支持 `--json`）
- `watch-index`：监听文件变更并自动刷新索引
- `completion`：生成 shell completion 脚本（bash/zsh/fish）
- `config path/validate`：查看配置路径与校验配置有效性
- `memory search/stats/inspect/feedback/prune/reindex`：长期记忆检索、诊断与维护
- `upgrade` / `uninstall`：CLI 自升级与卸载命令
- `chat/run` 自动注入当前工作区 `changed_paths + git diff` 增量上下文（可配置开关）
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
  - `build_vector_index`
  - `refresh_vector_index`
  - `query_vector_index`
  - `get_vector_index_stats`
  - `merge_vector_delta`
  - `lsp_definition`
  - `lsp_references`
  - `lsp_workspace_symbols`
  - `lsp_health`
- 默认工作目录沙箱（禁止访问工作区外路径）
- 常见危险命令拦截（如 `rm -rf`, `sudo`）

## 已实现核心能力（当前）

- Agent 执行闭环：基于 OpenAI Responses API 的工具调用循环（支持多轮工具调用与状态延续）。
- 工具安全约束：工作区路径沙箱、`apply_patch` 路径校验、危险命令拦截。
- 增量上下文注入：每轮自动注入 `changed_paths + git diff`（可配置开关和截断上限）。
- 代码索引（Code Index）：SQLite FTS5 检索、增量刷新、事件驱动刷新、查询缓存与慢查询指标。
- 语法索引（Syntax Index）：import/call 结构抽取、结构邻居检索、增量刷新、`auto/tree-sitter/skeleton` 解析策略。
- 语义图（Semantic Graph）：definition/reference/import/call 关系建图、`max_hops` 多跳扩展、去重与来源优先级。
- 精确索引导入（Precise Index）：支持导入 SCIP 归一化产物（`merge/replace`）并参与语义检索。
- 向量索引（Vector Index）：代码 chunk embedding、`base/delta` 双层、增量刷新与 layer 合并。
- 混合检索（Hybrid）：融合 semantic/syntax/index/vector，支持 embedding 二阶段重排与 freshness 降权。
- LSP 语义导航：`lsp_definition` / `lsp_references` / `lsp_workspace_symbols` / `lsp_health`，不可用时可回退到索引。
- 实时索引监听：`watch-index` 支持脏队列、debounce、batch、hash-skip 与 code/syntax/semantic/vector 协同刷新。
- 长期记忆（Memory）：跨会话存储经验（SQLite），按 `project/global` 作用域检索注入，支持反馈学习与保留期清理。
- 可观测与门禁：hybrid/watch JSONL 指标落盘、`metrics-report`/`metrics-check`、质量回归基准与覆盖率门禁。
- 结构化日志：运行时 JSONL 日志（默认 `.clawty/logs/runtime.log`），支持 `level/console/file/path` 配置。

当前边界（未实现）：

- `mcp-server` 已支持 facade + toolset 分层（默认 `analysis+ops`，`edit-safe` 需显式开启），但多租户策略仍未完善。

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
node src/index.js init
node src/index.js chat
node src/index.js run "读取 package.json 并总结这个项目"
```

## 命令

```bash
node src/index.js chat
node src/index.js run "your task"
node src/index.js init
node src/index.js init --include-vector
node src/index.js config show
node src/index.js config path --json
node src/index.js config validate
node src/index.js memory search "auth retry" --top-k 5
node src/index.js memory search "auth retry" --top-k 5 --explain
node src/index.js memory stats
node src/index.js memory inspect 12
node src/index.js memory feedback 12 --vote up --reason good --note "worked"
node src/index.js memory prune --days 90
node src/index.js memory reindex
node src/index.js completion bash
node src/index.js doctor
node src/index.js doctor --json
node src/index.js watch-index
node src/index.js upgrade
node src/index.js uninstall --yes --skip-npm
node src/index.js --help
npm run build:bin
npm run build:bin:clean
npm run init
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
npm run bench:hybrid
npm run bench:hybrid:check
npm run metrics:report
npm run metrics:check
npm run precise:check
npm run precise:check:fixture
```

一键安装脚本（渠道：npm / binary）：

```bash
bash scripts/install.sh --help
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

## 新仓库初始化（init）

`init` 用于“第一次接手代码库”的一键流程，默认执行：

1. `doctor` 预检
2. `build_code_index`
3. `build_syntax_index`
4. `build_semantic_graph`

可选附加向量索引：

```bash
node src/index.js init --include-vector
```

常见参数：

```bash
node src/index.js init --max-files 5000 --max-file-size-kb 1024
node src/index.js init --no-doctor --no-semantic
node src/index.js init --json
```

## 长期记忆（memory）

`memory` 用于跨会话经验沉淀与检索，默认存储在 `~/.clawty/memory.db`。

常用命令：

```bash
node src/index.js memory search "auth timeout" --top-k 5
node src/index.js memory search "auth timeout" --top-k 5 --explain
node src/index.js memory stats
node src/index.js memory inspect 12
node src/index.js memory feedback 12 --vote up --reason good --note "有效"
node src/index.js memory prune --days 90
node src/index.js memory reindex
```

作用域参数：

- `--scope project`：仅当前仓库经验
- `--scope global`：仅跨仓库经验
- `--scope project+global`：两者融合（默认）

Agent 在 `chat/run` 中会按配置自动注入 memory context（可关闭）。

## 二进制构建（实验）

项目已提供单文件二进制构建脚本（`esbuild + Node SEA + postject`）。

1. 安装构建依赖（一次即可）：

```bash
npm i -D esbuild postject
```

2. 构建：

```bash
npm run build:bin
```

3. 清理后重建：

```bash
npm run build:bin:clean
```

产物路径：

- `dist/clawty-<platform>-<arch>`（例如 `dist/clawty-darwin-x64`）
- `dist/clawty`（推荐启动器，默认注入 `NODE_NO_WARNINGS=1`）

运行方式（推荐）：

```bash
./dist/clawty --help
./dist/clawty doctor
```

说明：

- 当前脚本支持 `darwin` / `linux`。
- macOS 下会自动执行 ad-hoc `codesign`。
- 该能力为实验特性，建议在发布前做一次真实任务回归（`chat/run/watch-index`）。

## 用法文档

- 快速上手与场景化工作流：`docs/usage.md`

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
- `npm run bench:hybrid`：运行 hybrid+embedding 评测（含状态码/降级一致性）
- `npm run bench:hybrid:check`：按 `tests/bench/hybrid-embedding.baseline.json` 执行 5% 退化门禁
- `npm run bench:hybrid:baseline`：重写 hybrid+embedding 评测基线
- `npm run metrics:report`：输出最近 24h 核心指标报告（`code_index_lag_p95_ms` / `stale_hit_rate_avg` / `query_hybrid_p95_ms` / `degrade_rate` / `embedding_timeout_rate` / `embedding_network_rate` / `embedding_api_rate` / `embedding_unknown_rate` / `memory_query_p95_ms` / `memory_hit_rate` / `memory_fallback_rate`）
- `npm run metrics:check`：对核心指标执行阈值门禁（默认 `code_index_lag_p95_ms<=2000`、`stale_hit_rate_avg<=0.05`、`query_hybrid_p95_ms<=2000`、`degrade_rate<=0.1`；支持 `--max-embedding-timeout-rate` / `--max-embedding-network-rate` / `--min-embedding-attempts` / `--runbook-enforce`；memory 阈值可按需通过参数开启）
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
hybrid 降级处置手册位于 `docs/hybrid-degrade-runbook.md`。
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
- “启用 `query_hybrid_index` 的 freshness 降权（freshness_stale_after_ms=300000）再返回 Top5”
- “先构建 vector index（layer=base），再查询语义近邻代码块”
- “代码改完后刷新 vector index（changed_paths/deleted_paths, layer=delta）”
- “合并 vector delta 到 base 后，再做 query_hybrid_index”
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
`query_hybrid_index` 会联合 `semantic + vector + syntax + index` 候选并做轻量重排，支持 `path_prefix`、`language`、`include_vector` 与 `explain`。
可选启用 embedding 第二阶段重排（`enable_embedding` / `embedding_top_k` / `embedding_weight` / `embedding_model`），默认关闭。
可选启用 freshness 重排（`enable_freshness` / `freshness_stale_after_ms` / `freshness_weight` / `freshness_vector_stale_penalty`），用于 stale 候选降权。
返回 `sources.embedding` 观测字段（`status_code` / `error_code` / `latency_ms` / `rank_shift_count` / `top1_changed`），便于稳定性与效果追踪。
返回 `sources.freshness` 观测字段（`stale_hit_rate` / `stale_vector_candidates` / `sampled_paths` / `missing_paths`），便于跟踪索引新鲜度。
返回 `observability.online_tuner` 字段（`mode` / `decision_id` / `arm_id` / `reward`），便于观察在线调参决策与回报。
返回 `query_total_ms` 与 `degradation`（`degraded` / `failed_sources`）字段，并将 hybrid 查询指标按 JSONL 记录到 `.clawty/metrics/hybrid-query.jsonl`（可配置关闭）。
`build_vector_index` / `refresh_vector_index` 会将代码 chunk 生成 embedding 并写入离线向量层（`base` / `delta`），`merge_vector_delta` 可周期性合并增量层。
`query_vector_index` 支持 `path_prefix`、`language`、`layers`、`max_candidates`，用于语义召回候选。
`get_vector_index_stats` 返回向量层覆盖率与最近一次构建/刷新记录。
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
4. `refresh_vector_index`（可选，默认关闭）

常用命令：

```bash
node src/index.js watch-index
node src/index.js watch-index --interval-ms 1000 --max-batch-size 200
node src/index.js watch-index --debounce-ms 500 --hash-init-max-files 3000
node src/index.js watch-index --include-vector true --vector-layer delta
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
- `--include-vector <bool>`：开启/关闭 vector 刷新
- `--vector-layer <base|delta>`：vector 刷新写入层
- `--no-vector`：关闭 vector 刷新
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
- `CLAWTY_INDEX_FRESHNESS_ENABLED`：hybrid 检索是否启用 freshness 重排，默认 `true`
- `CLAWTY_INDEX_FRESHNESS_STALE_AFTER_MS`：freshness stale 阈值（毫秒），默认 `300000`
- `CLAWTY_INDEX_FRESHNESS_WEIGHT`：freshness 融合权重（0-1），默认 `0.12`
- `CLAWTY_INDEX_FRESHNESS_VECTOR_STALE_PENALTY`：stale vector 候选额外降权（0-1），默认 `0.25`
- `CLAWTY_INDEX_FRESHNESS_MAX_PATHS`：每次 hybrid 查询采样文件路径上限，默认 `200`
- `CLAWTY_AGENT_INCREMENTAL_CONTEXT_ENABLED`：是否自动注入 `changed_paths + git diff` 上下文，默认 `true`
- `CLAWTY_AGENT_INCREMENTAL_CONTEXT_MAX_PATHS`：每轮注入的变更路径上限，默认 `40`
- `CLAWTY_AGENT_INCREMENTAL_CONTEXT_MAX_DIFF_CHARS`：每轮注入的 diff 文本上限，默认 `12000`
- `CLAWTY_AGENT_INCREMENTAL_CONTEXT_TIMEOUT_MS`：采集 git 增量上下文的命令超时，默认 `3000`
- `CLAWTY_METRICS_ENABLED`：是否启用指标事件记录，默认 `true`
- `CLAWTY_METRICS_PERSIST_HYBRID`：是否落盘 hybrid 查询指标事件，默认 `true`
- `CLAWTY_METRICS_PERSIST_WATCH`：是否落盘 watch flush 指标事件，默认 `true`
- `CLAWTY_METRICS_PERSIST_MEMORY`：是否落盘 memory 查询指标事件，默认 `true`
- `CLAWTY_METRICS_QUERY_PREVIEW_CHARS`：指标事件中 `query_preview` 长度上限，默认 `160`
- `CLAWTY_TUNER_ENABLED`：是否启用在线调参引擎，默认 `false`
- `CLAWTY_TUNER_MODE`：在线调参模式（`off|shadow|active`），默认 `off`
- `CLAWTY_TUNER_DB_PATH`：在线调参状态库路径，默认 `.clawty/tuner.db`
- `CLAWTY_TUNER_EPSILON`：Bandit 探索率，默认 `0.08`
- `CLAWTY_TUNER_GLOBAL_PRIOR_WEIGHT`：全局先验权重，默认 `0.35`
- `CLAWTY_TUNER_LOCAL_WARMUP_SAMPLES`：仓库级后验暖启动样本数，默认 `50`
- `CLAWTY_TUNER_MIN_CONSTRAINT_SAMPLES`：约束判定最小样本数，默认 `30`
- `CLAWTY_TUNER_MAX_DEGRADE_RATE`：调参可行域 degrade 上限，默认 `0.1`
- `CLAWTY_TUNER_MAX_TIMEOUT_RATE`：调参可行域 timeout 上限，默认 `0.08`
- `CLAWTY_TUNER_MAX_NETWORK_RATE`：调参可行域 network 上限，默认 `0.05`
- `CLAWTY_TUNER_SUCCESS_REWARD_THRESHOLD`：在线成功阈值（reward），默认 `0.35`
- `CLAWTY_MEMORY_ENABLED`：是否启用长期记忆检索与注入，默认 `true`
- `CLAWTY_MEMORY_MAX_INJECTED_ITEMS`：每轮注入的 memory 条目数上限，默认 `5`
- `CLAWTY_MEMORY_MAX_INJECTED_CHARS`：每轮注入的 memory 文本上限，默认 `2400`
- `CLAWTY_MEMORY_AUTO_WRITE`：是否自动沉淀回合经验，默认 `true`
- `CLAWTY_MEMORY_WRITE_GATE_ENABLED`：是否启用 lesson 写入门控，默认 `true`
- `CLAWTY_MEMORY_MIN_LESSON_CHARS`：自动写入 lesson 的最小长度，默认 `80`
- `CLAWTY_MEMORY_DEDUPE_ENABLED`：是否启用同标题 lesson 合并，默认 `true`
- `CLAWTY_MEMORY_QUARANTINE_THRESHOLD`：负反馈隔离阈值，默认 `3`
- `CLAWTY_MEMORY_RANK_BM25_WEIGHT`：memory 检索 bm25 分量权重，默认 `0.34`
- `CLAWTY_MEMORY_RANK_RECENCY_WEIGHT`：memory 检索 recency 分量权重，默认 `0.16`
- `CLAWTY_MEMORY_RANK_CONFIDENCE_WEIGHT`：memory 检索 confidence 分量权重，默认 `0.12`
- `CLAWTY_MEMORY_RANK_SUCCESS_WEIGHT`：memory 检索 success_rate 分量权重，默认 `0.12`
- `CLAWTY_MEMORY_RANK_QUALITY_WEIGHT`：memory 检索 quality 分量权重，默认 `0.14`
- `CLAWTY_MEMORY_RANK_FEEDBACK_WEIGHT`：memory 检索 feedback 分量权重，默认 `0.12`
- `CLAWTY_MEMORY_RANK_PROJECT_BOOST`：memory 当前仓库 boost，默认 `1`
- `CLAWTY_MEMORY_RANK_GLOBAL_BOOST`：memory 跨仓库 boost，默认 `0.35`
- `CLAWTY_MEMORY_RANK_NEGATIVE_PENALTY_PER_DOWNVOTE`：每个负反馈惩罚，默认 `0.06`
- `CLAWTY_MEMORY_RANK_NEGATIVE_PENALTY_CAP`：负反馈惩罚上限，默认 `0.3`
- `CLAWTY_MEMORY_RANK_RECENT_NEGATIVE_PENALTY`：近期负反馈额外惩罚，默认 `0.18`
- `CLAWTY_MEMORY_RANK_RECENT_NEGATIVE_RECENCY_THRESHOLD`：近期负反馈判定阈值，默认 `0.55`
- `CLAWTY_MEMORY_SCOPE`：memory 作用域，默认 `project+global`
- `CLAWTY_WATCH_INTERVAL_MS`：watch 轮询间隔（毫秒），默认 `2000`
- `CLAWTY_WATCH_MAX_FILES`：watch 最大跟踪文件数，默认 `20000`
- `CLAWTY_WATCH_MAX_BATCH_SIZE`：watch 增量批大小，默认 `300`
- `CLAWTY_WATCH_DEBOUNCE_MS`：watch 队列防抖窗口（毫秒），默认 `500`
- `CLAWTY_WATCH_HASH_SKIP_ENABLED`：watch 是否启用 hash skip，默认 `true`
- `CLAWTY_WATCH_HASH_INIT_MAX_FILES`：watch 启动 hash 缓存文件上限，默认 `2000`
- `CLAWTY_WATCH_BUILD_ON_START`：watch 启动时是否先全量构建，默认 `true`
- `CLAWTY_WATCH_INCLUDE_SYNTAX`：watch 是否刷新 syntax index，默认 `true`
- `CLAWTY_WATCH_INCLUDE_SEMANTIC`：watch 是否刷新 semantic graph，默认 `true`
- `CLAWTY_WATCH_INCLUDE_VECTOR`：watch 是否刷新 vector index，默认 `false`
- `CLAWTY_WATCH_VECTOR_LAYER`：watch vector 写入层（`base`/`delta`），默认 `delta`
- `CLAWTY_WATCH_SEMANTIC_INCLUDE_DEFINITIONS`：watch 语义刷新是否包含 definition，默认 `false`
- `CLAWTY_WATCH_SEMANTIC_INCLUDE_REFERENCES`：watch 语义刷新是否包含 references，默认 `false`
- `CLAWTY_WATCH_QUIET`：watch 是否静默模式，默认 `false`

## 配置系统

支持三层配置输入：

1. 全局配置：`~/.clawty/config.json`  
2. 项目配置：`.clawty/config.json`（兼容旧路径 `clawty.config.json`）  
3. 环境变量：`.env` 和系统环境变量

优先级（高 -> 低）：

1. 系统环境变量
2. `.env`
3. 项目配置（`.clawty/config.json` / 旧路径 `clawty.config.json`）
4. 全局配置（`~/.clawty/config.json`）
5. 内置默认值

你可以通过下面命令查看最终生效配置与路径（API Key 会脱敏）：

```bash
node src/index.js config show
node src/index.js config path --json
node src/index.js config validate
```

可参考示例文件：`clawty.config.example.json`。

## 说明

- 当前是 MVP，目标是先跑通“模型 + 工具调用 + 基础安全约束”的闭环。
- 当前能力已覆盖：代码/语法/语义/向量索引与 hybrid 融合检索、watch 自动增量刷新、长期记忆沉淀与召回。
- 后续重点可继续扩展：MCP 多租户权限模型、团队协作与策略编排能力。
