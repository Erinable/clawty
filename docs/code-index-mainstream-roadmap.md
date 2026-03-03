# Code Index Mainstream Gap Roadmap

更新时间：2026-03-03

本路线图从“已实现能力”出发，升级为按八个维度推进的工程化计划，目标是在大仓库和高频变更场景下，同时提升检索质量、稳定性、可观测性与迭代效率。

## 实施进度（本分支）

当前分支：`code-index-phase1-orchestrator-foundation`

阶段 1（基础治理）已完成项：

- `src/mcp-server.js` 完成拆分，职责下沉到 runtime/cli/toolset policy/dispatch 等模块，主文件已收敛为装配层。
- `src/index-watch.js` 完成队列、hash、flush/metrics、snapshot/diff、config、loop、path policy 的模块化拆分。
- `src/tools.js` 完成工具 schema、安全策略、本地工具 handlers、查询工具 handlers 的模块化拆分，主文件由大而全转为组合入口。
- 检索编排层与结果协议已抽取：
  - `src/retrieval-orchestrator.js`
  - `src/retrieval-result-protocol.js`
  - `src/hybrid-source-status.js`
- 指标命名常量统一抽取到 `src/metrics-event-types.js`，`tools/watch/memory/report` 链路复用统一事件名与指标文件名。
- 新增契约测试覆盖拆分模块：
  - `tests/mcp-toolset-policy.test.js`
  - `tests/mcp-tool-dispatch.test.js`
  - `tests/tool-local-handlers.test.js`
  - `tests/tool-query-handlers.test.js`
  - `tests/retrieval-orchestrator.test.js`
  - `tests/retrieval-result-protocol.test.js`
  - `tests/hybrid-source-status.test.js`

阶段 1 余项（下一步）：

- 将统一编排层与结果协议继续接入更多查询路径，减少融合层分支判断。
- 持续完成构建/刷新/查询/降级四链路指标字段命名收敛（当前已完成 watch/memory/hybrid 主链路常量化）。

阶段 2 起步（已落地）：

- 新增 hybrid 多策略回放评测 harness：
  - `tests/bench/hybrid-replay.bench.js`
  - `tests/fixtures/hybrid-cases/replay-presets.json`
  - `tests/bench/hybrid-replay.baseline.json`
- 新增 `bench:hybrid:replay / :check / :baseline` 命令，支持按 preset 回放、分桶指标输出与基线门禁。
- 新增失败样本闭环：
  - `bench:hybrid:replay:failures` 导出失败样本集
  - `bench:hybrid:replay:failure:check` 校验“无新增失败样本”门禁

阶段 3 起步（已落地）：

- `watch-index` 新增队列反压参数与动态 debounce：
  - `backpressure_threshold_ratio`
  - `backpressure_debounce_ms`
  - `no-backpressure`
- `watch_metrics`/`watch-flush` 增加反压观测字段（poll/flush 计数、effective debounce、threshold）。
- `metrics-report` 增加 watch 反压/时延 KPI：
  - `watch_backpressure_flush_rate`
  - `watch_effective_debounce_p95_ms`
  - `watch_refresh_p95_ms`
- `metrics-check` 新增可选 watch 门禁参数：
  - `--max-watch-backpressure-flush-rate`
  - `--max-watch-effective-debounce-p95-ms`

阶段 3 余项（下一步）：

- 增加 watch 刷新趋势视图（按日/周）与 profile 基线（refresh_ms/index_lag_ms 分桶）。
- 继续推进队列策略（并发窗口、饥饿保护、反压阈值自动调参）。

## 当前基线（已落地能力）

基线能力以 `README.md` 已实现清单为准，核心包括：

- 索引链路：`code/syntax/semantic/vector/hybrid` 全链路可用，支持增量刷新与融合检索。
- 运行链路：`watch-index` 具备脏队列、debounce、batch、hash-skip 与反压协同刷新。
- 质量链路：hybrid/watch 指标落盘，`metrics-report` 与 `metrics-check` 可执行门禁（含 replay 基线与失败样本门禁）。
- 稳定链路：LSP 不可用可回退索引，hybrid 具备降级与状态码观测。
- 安全链路：路径沙箱、危险命令拦截、`apply_patch` 路径校验、MCP 工具分级暴露。

当前缺口：编排层协议尚未完全覆盖所有查询路径、回放样本规模与分桶仍偏小、watch 大仓 profile 与阈值自动化调参尚未形成闭环、降级矩阵与审计链路仍待完善。

## 路线图原则

1. 保持事件驱动增量刷新，不回退为 commit 驱动开发态索引。
2. 检索“编排层”与“子索引实现层”分离，降低跨层耦合。
3. 任何高成本/高风险链路都必须可降级、可观测、可回放。
4. 发布门禁必须同时覆盖性能、质量、稳定性与安全。

## 八维度目标与 KPI

| 维度 | 目标 | 核心动作 | KPI |
| --- | --- | --- | --- |
| 架构 | 降低复杂度与耦合 | 拆分 `src/tools.js` / `src/mcp-server.js`；建立统一检索编排层；标准化检索结果协议（来源/置信度/时效/去重键） | 核心模块圈复杂度下降；跨模块依赖边数量下降；单次改动影响文件数下降 |
| 检索质量 | 提升 Top-K 命中率与可解释性 | hybrid 权重配置化；按语言/文件类型/意图分桶回放；失败样本持续回归；解释字段补齐 | Top-3/Top-5、MRR 提升；二次追问率下降 |
| 性能 | 控制时延与吞吐抖动 | 优化 `src/index-watch.js` 队列策略；分层缓存（查询/结构/embedding）；热点路径 profile | `query_hybrid` P50/P95；增量刷新耗时；watch 堆积长度 |
| 成本 | 降低向量与重排开销 | embedding 冷热分层、过期回收、批量更新；二阶段轻量裁剪；自适应分块 | 单次查询成本；索引存储体积；向量更新成本曲线 |
| 稳定性 | 子系统异常可持续服务 | 明确降级优先级（LSP→语义图→语法/文本）；刷新任务幂等与重试预算；长链路 checkpoint | 降级成功率；恢复时间；重试成功率 |
| 可观测 | 可定位、可归因、可回放 | 统一构建/刷新/查询/降级指标命名；查询结果关联索引状态；周趋势质量报表 | 平均故障定位时间；回归提前发现率；问题复现率 |
| 安全 | 最小权限与可审计 | MCP 工具白名单强化；高风险工具细粒度开关；配置/环境变量敏感项扫描 | 高危操作拦截率；审计覆盖率；安全回归通过率 |
| 工程效率 | 可灰度、可回滚、可复盘 | 工具契约测试与跨模块集成测试；A/B 开关；发布三件套门禁（性能+质量+变更说明） | 发布失败率；回滚率；交付周期 |

## 分阶段执行计划

### 阶段 1：基础治理（模块解耦 + 指标统一）

目标：先治理复杂度和观测标准，建立后续迭代的稳定骨架。

- 拆分 `src/tools.js`：
  - 工具注册/参数校验/执行逻辑分层。
  - 索引类工具迁移到独立 toolset 模块。
- 精简 `src/mcp-server.js`：
  - 传输层、工具集选择、权限策略三层解耦。
- 建立统一检索编排层（建议新增 `src/retrieval-orchestrator.js` 与策略子模块）。
- 统一指标命名：构建、刷新、查询、降级四条主链路统一维度字段。

退出标准：

- `src/tools.js` 与 `src/mcp-server.js` 复杂度下降并通过现有测试。
- 新旧调用路径并存且默认行为不回归。

### 阶段 2：质量提升（融合调参与失败样本回放）

目标：把“效果调优”变成可重复实验流程。

- 建立 hybrid 回放框架：
  - 权重配置外置（语言/文件类型/查询意图分桶）。
  - 支持基线结果与候选配置对比。
- 建立失败样本集（误召回/漏召回）与 query pattern 标签。
- 强化 explain 输出：命中原因、路径、邻接跳数、freshness 分。

退出标准：

- 固化一套可重复回放命令与报告模板。
- Top-3/Top-5 或 MRR 相对基线可量化提升。

### 阶段 3：性能与成本（缓存分层 + 批处理优化）

目标：控制大仓库压力下的时延、吞吐和成本。

- 深化 `src/index-watch.js` 队列治理：
  - 批处理窗口、并发窗口、饥饿保护与反压策略。
- 建立分层缓存与失效策略：
  - 查询级、结构级、embedding 级缓存分离。
- 二阶段检索轻量候选裁剪，减少高成本重排调用。
- embedding 冷热分层、过期回收与批量更新。

退出标准：

- 查询 P95 与增量刷新时间稳定在门限内。
- 单次查询成本和索引体积增长率可控。

### 阶段 4：稳定与安全（降级矩阵 + 审计最小权限）

目标：把“出问题时能用”转成可演练、可审计机制。

- 固化降级矩阵：
  - LSP 不可用 → 语义图。
  - 语义图异常 → 语法索引/文本索引。
  - embedding 超时/网络/API 错误 → 跳过重排并记录状态码。
- 索引刷新任务引入幂等键与重试预算，防止重复污染。
- 高风险工具开关 + MCP 审计日志增强 + 敏感配置扫描。

退出标准：

- 关键故障演练通过，降级成功率达标。
- 高风险操作可追踪且审计覆盖核心路径。

### 阶段 5：工程化闭环（灰度 + A/B + 门禁自动化）

目标：让策略改动可灰度验证并可快速回滚。

- A/B 配置开关接入 hybrid 融合策略与缓存策略。
- 契约测试覆盖工具输入输出；补齐跨模块集成测试。
- 发布门禁三件套：
  - 性能基线（时延/吞吐/成本）
  - 质量基线（Top-K/MRR/回归样本）
  - 变更说明与回滚路径

退出标准：

- 版本发布可灰度、可回滚、可复盘。
- 发布失败率和回滚率持续下降。

## 建议优先级（先做这 4 件）

1. 推进统一检索编排层/结果协议在更多查询路径落地，继续收敛融合逻辑。
2. 扩展统一评测集（语言/文件类型/意图/query pattern）并持续 failure-sample 回归。
3. 完成 watch profile 基线与阈值收敛（队列策略 + refresh/index_lag 趋势 + 门禁策略）。
4. 完成降级矩阵与查询-索引状态关联追踪（含 runbook 与审计字段）。

## 执行里程碑（建议）

- 里程碑 M1（阶段 1 完成）：完成模块解耦最小切分 + 指标命名统一。
- 里程碑 M2（阶段 2 完成）：形成可重复回放体系与失败样本集。
- 里程碑 M3（阶段 3 完成）：watch 与 hybrid 性能/成本达到发布门限。
- 里程碑 M4（阶段 4 完成）：降级矩阵、审计链路与安全扫描全部上线。
- 里程碑 M5（阶段 5 完成）：A/B + 门禁自动化进入常态发布流程。

```mermaid
flowchart LR
  A[阶段1 基础治理\n模块解耦/指标统一] --> B[阶段2 质量提升\n融合调参/失败样本回放]
  B --> C[阶段3 性能与成本\n缓存分层/批处理优化]
  C --> D[阶段4 稳定与安全\n降级策略/审计与最小权限]
  D --> E[阶段5 工程化闭环\n灰度+A/B+门禁自动化]
```
