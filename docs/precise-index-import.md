# Precise Index Import (Phase 2)

`import_precise_index` 用于把精确索引事实（推荐：SCIP 归一化 JSON）写入语义图。

默认情况下，`build_semantic_graph` 会按以下候选路径自动尝试精确导入（精确优先模式）：
- `artifacts/scip.normalized.json`
- `.clawty/scip.normalized.json`
- `scip.normalized.json`

可通过 `precise_index_path` / `precise_index_paths` 覆盖候选列表。

## 导入前置

1. 先构建代码索引：`build_code_index`
2. 再导入精确事实：`import_precise_index`

CLI 脚本等价流程：

- `npm run precise:check`：校验 `artifacts/scip.normalized.json`（缺失时跳过）
- `npm run precise:check:fixture`：校验内置精确索引夹具（CI 门禁）
- `npm run precise:import`：执行 `build_code_index + import_precise_index`

## 入参

- `path`：工作区内 JSON 文件路径（必填）
- `mode`：`merge`（默认）或 `replace`
- `source`：来源标签（默认 `scip`）
- `max_nodes` / `max_edges`：导入上限（防止超大输入）

## JSON 格式（scip-normalized/v1）

```json
{
  "format": "scip-normalized/v1",
  "nodes": [
    {
      "symbol": "pkg alpha",
      "path": "src/alpha.ts",
      "name": "AlphaService",
      "kind": "class",
      "line": 12,
      "column": 1,
      "lang": "javascript"
    }
  ],
  "edges": [
    {
      "from": "pkg alpha",
      "to": "pkg beta",
      "edge_type": "definition",
      "weight": 4
    }
  ]
}
```

说明：
- `nodes` 也可用 `symbols` 字段名。
- `edges` 也可用 `relationships` 字段名。
- `edge_type` 建议使用：`definition` / `reference` / `call` / `import`。
- 查询阶段会对同实体做去重，优先返回精确来源（`scip > lsif > lsp > syntax > index_seed > lsp_anchor`）。

## 可观测性

`get_semantic_graph_stats` 新增：

- `source_mix`：节点/边来源占比（含 `precise_count`、`precise_ratio`）。
- `precise_freshness`：最近一次精确导入信息（`latest_import`、`age_minutes`、`is_stale`）。

可通过 `CLAWTY_PRECISE_STALE_AFTER_MINUTES`（默认 `1440`）调整新鲜度阈值。
