# Precise Index Import (Phase 2)

`import_precise_index` 用于把精确索引事实（推荐：SCIP 归一化 JSON）写入语义图。

## 导入前置

1. 先构建代码索引：`build_code_index`
2. 再导入精确事实：`import_precise_index`

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
