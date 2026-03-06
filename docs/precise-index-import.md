# Precise Index Import

`import_precise_index` 用于导入外部精确事实（推荐 SCIP normalized JSON）到语义图。

## 1. 自动候选路径

当执行 `build_semantic_graph` 且启用精确优先策略时，会按顺序尝试：

1. `artifacts/scip.normalized.json`
2. `.clawty/scip.normalized.json`
3. `scip.normalized.json`

可通过 `precise_index_path` / `precise_index_paths` 覆盖。

## 2. 推荐流程

```bash
# 1) 先有 code index 基座
node src/index.js run "构建代码索引"

# 2) 导入精确事实（脚本方式）
npm run precise:import
```

相关脚本：

- `npm run precise:check`
- `npm run precise:check:fixture`
- `npm run precise:import`

## 3. 入参

- `path`：工作区内 JSON 路径（必填）
- `mode`：`merge`（默认）或 `replace`
- `source`：来源标签（默认 `scip`）
- `max_nodes` / `max_edges`：导入上限保护

## 4. 输入格式（scip-normalized/v1）

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

兼容字段：

- `nodes` 也可写作 `symbols`
- `edges` 也可写作 `relationships`

## 5. 可观测字段

`get_semantic_graph_stats` 包含：

- `source_mix`
- `precise_freshness`

新鲜度阈值可由 `CLAWTY_PRECISE_STALE_AFTER_MINUTES` 调整（默认 `1440`）。
