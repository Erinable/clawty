# Code Index Mainstream Gap Roadmap

本路线图用于把当前索引方案按“主流能力对齐”顺序落地，遵循先高 ROI、再高复杂度的原则。

## 当前基线（已具备）

- 词法索引：SQLite + FTS5，支持 full/incremental/event refresh。
- 结构索引：syntax import/call 边（auto/tree-sitter/skeleton）。
- 语义图：支持 `scip > lsif > lsp > syntax > index_seed > lsp_anchor` 优先级与多跳查询。
- 质量门禁：`coverage:check` + `bench:index` + `bench:semantic` + `bench:graph` + `bench:graph:refresh`。

## 优先级与依赖

1. P1 多语言语义种子与召回稳定性（必须先做）
2. P2 精确索引生产化（SCIP/LSIF pipeline）
3. P3 混合检索与重排（词法+结构+语义）
4. P4 扩展性与实时化（分片/监听器）

说明：P2 依赖 P1 的多语言 seed；P3 依赖 P2 的精确事实覆盖；P4 最后做。

## P1（最高优先）多语言语义种子

目标：消除 JS-only 语义种子限制，提升跨语言工程召回率。

核心任务：
- 移除 `semantic-graph` 中 `selectSeedSymbols` 的 `f.lang='javascript'` 过滤，改为配置化语言白名单（默认不过滤）。
- 在 `query_semantic_graph` 增加语言分布统计，便于观察召回偏置。
- 扩展测试夹具：新增 Python/Go seed 与多跳链路用例。

验收标准：
- `node --test tests/semantic-graph.test.js` 全通过。
- `npm run bench:graph:check` 与 `npm run bench:semantic:check` 无退化。
- 新增跨语言用例 `primary_top3_rate` 达到基线目标（建议 >= 0.7）。

回滚策略：
- 增加开关 `CLAWTY_SEMANTIC_SEED_LANG_FILTER`（默认 `*`），异常时可快速回退到旧策略。

## P2 精确索引生产化（SCIP/LSIF）

目标：把“可导入”升级为“持续产出 + 自动导入 + 新鲜度可观测”。

核心任务：
- 增加 `scripts/` 级产物检查与导入脚本（统一产出到 `artifacts/scip.normalized.json`）。
- 在 CI 增加“精确索引有效性检查”（格式、节点/边规模、空图保护）。
- `get_semantic_graph_stats` 增加 `source_mix` 与 `precise_freshness` 指标。

验收标准：
- 无精确产物时维持现有回退链路可用。
- 有精确产物时，`query_semantic_graph` 的 `scip` 来源占比显著提升。

## P3 混合检索与重排

目标：提升 LLM 任务中的语义相关性与证据完整性。

核心任务：
- 建立候选融合：`code_index + syntax + semantic_graph` 联合召回。
- 引入轻量重排（特征：source priority、path proximity、symbol overlap、hop penalty）。
- 在 `tests/fixtures/semantic-cases` 增加“同名符号歧义”与“跨目录调用”难例。

验收标准：
- `mean_reciprocal_rank`、`evidence_recall_at_k` 较基线提升。
- `query_p95_ms` 退化不超过既定阈值（建议 <= 15%）。

## P4 扩展性与实时化（后置）

目标：支持更大仓库与更高刷新频率。

核心任务：
- 分片索引（按目录或语言切分）与并行查询聚合。
- 文件系统事件监听器，减少手动 refresh 触发。
- 热点查询缓存分层（内存 + SQLite 统计驱动）。

## 执行节奏（建议）

1. 第 1 周：完成 P1（代码 + 测试 + 基线更新）。
2. 第 2-3 周：完成 P2（产物流水线 + 指标落地）。
3. 第 4-5 周：完成 P3（融合召回 + 重排 + 难例评测）。
4. P4 按仓库规模与性能压力择机启动。
