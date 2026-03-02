# Code Index Release Checklist

发布代码索引能力前，按本清单逐项确认。默认要求全部通过后再合并到 `main`。

## 1. 变更范围确认

- [ ] 说明本次变更类型：`ranking` / `indexing` / `refresh` / `syntax` / `semantic_fallback` / `telemetry` / `tests`。
- [ ] 在 PR 描述中列出影响 API 字段（如 `candidate_profile`、`query_metrics`）。
- [ ] 若修改了基准或黄金数据，说明原因和预期收益。

## 2. 自动化门禁

- [ ] 运行全量测试：`npm test`
- [ ] 覆盖率检查：`npm run test:coverage`
- [ ] 性能门禁：`npm run bench:index:check`
- [ ] 语义质量门禁：`npm run bench:semantic:check`
- [ ] 结构查询门禁：`node --test tests/syntax-index.test.js`
- [ ] 回退链路门禁：`node --test tests/tools.test.js`
- [ ] CI 绿灯（`Node 22/24`）后再合并。

## 3. 回归测试要求

- [ ] 质量回归：`tests/code-index-quality.test.js`
- [ ] 增量一致性回归：`tests/code-index-consistency.test.js`
- [ ] 边界与缓存回归：`tests/code-index.test.js`
- [ ] 语法结构回归：`tests/syntax-index.test.js`
- [ ] 语义图融合回归：`tests/semantic-graph.test.js`
- [ ] 工具回退回归：`tests/tools.test.js`
- [ ] 语义任务回归：`npm run bench:semantic:check`

如改动触发以下场景，必须补对应用例：

- [ ] 新过滤条件或排序权重
- [ ] 候选召回策略（chunk/symbol limit）
- [ ] 缓存行为（TTL、淘汰、失效）
- [ ] 刷新流程（incremental/event/full fallback）
- [ ] 语法查询能力（`query_syntax_index`）
- [ ] 回退策略（`semantic -> syntax -> index`）

## 4. 结果验收基线

- [ ] `code-index.js` 分支覆盖率保持 `>= 80%`。
- [ ] `bench:index:check` 无回归（阈值 `20%`）。
- [ ] `bench:semantic:check` 无回归（阈值 `5%`）。
- [ ] `query_semantic_graph` 回退顺序稳定：`semantic > syntax > index`。
- [ ] 不允许引入明显不稳定排序（同数据多次查询 top 结果抖动）。

## 5. 基线更新规则

仅在“有意性能变化”时更新基线：

1. 先运行：`npm run bench:index`
2. 再写入：`npm run bench:index:baseline`
3. 在 PR 说明中附上变更前后对比（`build_ms` / `refresh_ms` / `query_p95_ms` / `index_bytes`）

若性能变慢但有合理收益（例如召回率显著提升），需在 PR 中明确 trade-off。

## 6. 发布记录

- [ ] 在 PR 中附上本次执行命令与关键输出摘要。
- [ ] 标记是否需要同步更新 README（新增字段、行为变化）。
- [ ] 若涉及结构检索，附上 `query_syntax_index` 样例输出摘要。
- [ ] 若涉及回退策略，附上 `query_semantic_graph` 回退 provider 结果（`syntax` 或 `index`）。
- [ ] 合并后观察一轮真实仓库使用反馈，再决定是否调整基线。
