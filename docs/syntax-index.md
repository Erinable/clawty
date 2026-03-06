# Syntax Index

`syntax index` 提供“结构关系检索”，核心是 import/call 边，不等价于完整语义分析。

## 1. 能力边界

- 输入来源：代码文件内容（在工作区范围内）
- 输出结构：`imports`、`calls`、文件级结构统计
- 存储位置：`.clawty/index.db`
- 典型用途：邻接关系定位、语义图补边、降级检索支撑

## 2. 相关工具

- `build_syntax_index`
- `refresh_syntax_index`
- `query_syntax_index`
- `get_syntax_index_stats`

## 3. 推荐使用流程

1. 先执行 `build_code_index`
2. 再执行 `build_syntax_index`
3. 增量变更执行 `refresh_code_index + refresh_syntax_index`
4. 用 `query_syntax_index` 查询结构邻居
5. 用 `get_syntax_index_stats` 观察覆盖与边规模

## 4. 关键参数

构建/刷新：

- `max_files`
- `max_calls_per_file`
- `max_errors`
- `changed_paths`
- `deleted_paths`
- `parser_provider`（`auto|skeleton|tree-sitter`）
- `parser_strict`

查询：

- `query`
- `top_k`
- `max_neighbors`
- `path_prefix`

## 5. 当前实现说明

- `auto` 策略：`TS/JS/Python/Go` 优先 tree-sitter，其余回退 skeleton。
- 支持全量构建、增量刷新、事件驱动刷新。
- `build_semantic_graph` 在 `include_syntax=true` 时会摄取 syntax 边。
- `query_semantic_graph` 在语义图不足时可回退到 syntax，再回退到 code index。
