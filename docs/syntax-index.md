# Syntax Index (Phase 3)

`syntax index` 为代码索引增加“结构层”能力：在 `build_code_index` 产出的 `files` 基础上，提取 import/call 边并写入 `.clawty/index.db`。

## 可用工具

1. `build_syntax_index`
2. `refresh_syntax_index`
3. `query_syntax_index`
4. `get_syntax_index_stats`

## 推荐流程

1. 先执行 `build_code_index`
2. 再执行 `build_syntax_index`
3. 代码变更后执行 `refresh_code_index` + `refresh_syntax_index`
4. 用 `query_syntax_index` 做结构邻居检索
5. 通过 `get_syntax_index_stats` 观察覆盖与结构边规模

## 关键参数

- `max_files`: 本次最多解析文件数
- `max_calls_per_file`: 单文件 call 边上限
- `max_errors`: 错误上限，达到后提前停止
- `changed_paths` / `deleted_paths`: 事件驱动刷新输入
- `query`, `top_k`, `max_neighbors`, `path_prefix`: 结构查询参数
- `parser_provider`: `auto`（默认）/ `skeleton` / `tree-sitter`
- `parser_strict`: `tree-sitter` 不可用时是否直接失败（默认 false，回退 skeleton）

## 当前实现说明

- 当前 provider 为 `tree-sitter-skeleton`，采用轻量提取逻辑（非完整 AST 语义）。
- 已支持 `tree-sitter` provider（可选），用于 TS/JS/Python/Go 的 AST 提取；依赖可用时生效。
- 支持全量、增量、事件三种刷新模式。
- `get_syntax_index_stats` 返回 `counts`、`top_callers`、`top_imported`、`latest_run`，可作为语义图构建前的结构信号。
- `build_semantic_graph` 在 `include_syntax=true`（默认）时，会摄取 syntax `import/call` 边到语义图，来源标记为 `syntax`。
- `query_semantic_graph` 在语义图为空时，会优先回退到 `query_syntax_index`，再回退到 `query_code_index`。
