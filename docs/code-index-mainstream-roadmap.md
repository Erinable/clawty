# Code Index Mainstream Gap Roadmap

本路线图更新为“事件驱动 + 分层增量”的工程化版本，目标是在高频代码变更下保持索引新鲜度、检索质量与可运营性。

## 当前状态（截至 2026-03-02）

已完成：

- P1 多语言语义种子与可观测：`ca47e14`
- P2 精确索引生产化（SCIP 导入 + 新鲜度指标）：`1652ad5`
- P3 混合检索与轻量重排：`38024a7`
- P4 监听器与实时刷新回路（watch-index）：`20a2448`
- P5-A 可选 embedding 重排 + 降级可观测：`bcb091d`、`ca1fc5a`

当前主要缺口：

- `watch-index` 仍缺 dirty queue/debounce/hash skip，突发变更下可能重复刷新。
- embedding 仍以在线重排为主，缺离线向量资产层（base+delta）。
- 查询层缺 `freshness_score` 主特征，stale 降权策略不完整。

## 核心原则

1. 不按 commit 驱动开发态索引，按文件变更事件驱动。
2. commit/pipeline 仅用于离线基座重建、校验与发布。
3. 快慢分层：秒级可用优先，分钟级质量增强异步补齐。
4. 任何 embedding 失败都只降级，不阻断 `code + syntax + graph` 主链路。

## 新鲜度 SLO（目标）

- `code_index_lag_ms`：P95 < 2000ms
- `syntax_graph_lag_ms`：P95 < 10000ms
- `embedding_lag_ms`：P95 < 300000ms（5min）
- `stale_hit_rate`：< 5%
- `query_hybrid_p95_ms`：不高于当前基线 15%

## 目标架构（分层增量）

1. 快通道（秒级）：`code index` 文件级事件增量。
2. 中通道（十秒级）：`syntax + semantic graph` 受影响路径/符号局部刷新。
3. 慢通道（分钟级）：离线向量增量（base+delta，周期 merge）。

## 后续阶段与优先级

### P5-B（最高优先）事件调度工程化

目标：让 `watch-index` 在高频改动下稳定、去重、低抖动。

核心任务：

- 在 `src/index-watch.js` 增加 dirty set、300-800ms debounce、20-100 微批。
- 增加内容 hash skip（内容未变则跳过后续刷新）。
- 增加队列指标：`queue_depth`、`batch_size`、`index_lag_ms`。

验收标准：

- 高频编辑压测下无明显重复刷新风暴。
- `code_index_lag_ms` P95 达到 SLO。

### P6 离线向量索引（base+delta）

目标：把 embedding 从“在线重排”为主升级为“离线召回资产”。

核心任务：

- 定义 `chunk_id`（含 `chunking_version`）与 chunk 元数据模型。
- 建立离线 embedding pipeline（内容地址缓存 + 模型版本化）。
- 建立 `base index + delta index`，支持增量插入、删除与周期 merge。

验收标准：

- 在线 embedding 调用量显著下降，查询延迟更稳定。
- embedding lag 受控在 SLO 内。

### P7 查询侧新鲜度融合与增量上下文

目标：让 LLM 在索引未完全收敛时仍能优先拿到“最新证据”。

核心任务：

- 在 `query_hybrid_index` 引入 `freshness_score` 与 stale 降权。
- stale embedding 候选自动降权；缺失时回退 lexical/graph。
- Agent 每轮优先注入 `changed_paths + git diff`，索引补充证据。

验收标准：

- stale_hit_rate 低于目标阈值。
- 高频改动任务的 top-1 命中率提升。

### P8 扩展性（分片 + 快照切换）

目标：提升大仓库吞吐与稳定性。

核心任务：

- 索引按目录/语言分片并行刷新。
- 读写分离：后台构建新快照，前台查询原子切换。
- 热点文件/查询缓存分层。

### P9 质量门禁与运营化

目标：把“效果、性能、成本”固化为可持续门禁。

核心任务：

- 增加 hybrid+embedding 评测集（Recall@K/MRR/nDCG）。
- CI 加入新鲜度与延迟回归门禁。
- 建立降级 runbook（timeout/network/api/error_code 分流）。

## 执行节奏（建议）

1. 迭代 1：完成 P5-B（调度层），先稳住高频变更场景。
2. 迭代 2-3：完成 P6（离线向量资产层）并打通 watch 增量。
3. 迭代 4：完成 P7（freshness 融合 + diff 优先上下文）。
4. 迭代 5+：按规模压力推进 P8/P9。
