# Code Index Mainstream Roadmap

更新时间：2026-03-06

本文是当前主线的中期路线图，目标是：在大仓和高频变更场景下，持续提升检索质量、稳定性、可观测性与维护效率。

## 1. 当前基线（已具备）

- 索引链路：`code/syntax/semantic/vector/hybrid`
- 增量链路：`watch-index`（队列、debounce、hash skip、反压、重试）
- 质量链路：benchmark + replay + failure samples + metrics gates
- 降级链路：LSP 不可用可回退到索引检索
- MCP 链路：toolset 策略 + facade 暴露 + 低层工具受控开放

## 2. 仍需补强的关键点

1. 检索编排层在所有查询路径的覆盖一致性。
2. replay 样本规模与分桶维度（语言/意图/query pattern）覆盖深度。
3. watch 在大仓场景的 profile 基线和阈值治理。
4. 降级矩阵与异常审计链路的自动化闭环。

## 3. 目标与 KPI

| 维度 | 目标 | 示例 KPI |
| --- | --- | --- |
| 质量 | 提升 Top-K 与稳定性 | `top3`、`MRR`、`task_success_rate` |
| 性能 | 控制查询与刷新时延抖动 | `query_hybrid_p95_ms`、`watch_refresh_p95_ms` |
| 稳定性 | 异常可降级、可恢复 | `degrade_rate`、`db_retry_exhausted_rate` |
| 可观测 | 问题可定位、可复现 | `metrics:report` 完整度、replay 可复现率 |
| 安全性 | 对外能力最小化暴露 | MCP policy 拦截正确率 |

## 4. 分阶段计划

### 阶段 A：边界治理与协议收敛

- 继续收敛 `tools` / `mcp` / `watch` 的职责边界。
- 统一 retrieval explain 字段与来源状态协议。

退出标准：

- 关键路径都经过统一编排层与协议层。

### 阶段 B：质量回放体系强化

- 扩展 replay case 与失败样本。
- 固化 baseline 更新流程和 PR 变更说明模板。

退出标准：

- 质量变更都可通过 replay 量化。

### 阶段 C：性能与成本治理

- 强化 watch 反压和批量策略。
- 优化 embedding 重排成本与降级策略。

退出标准：

- 大仓场景下 P95 与队列深度稳定在阈值内。

### 阶段 D：发布与审计闭环

- 完成 runbook + checklist + gates 的联动。
- 建立异常回溯的最小审计路径。

退出标准：

- 发布前验证路径稳定、可重复、可追踪。

## 5. 本期优先级（建议）

1. 扩展 `hybrid replay` 覆盖并提升 failure sample 质量。
2. 完成 watch profile 基线和阈值收敛。
3. 补齐降级矩阵与 runbook 映射自动检查。
4. 持续清理文档漂移，确保 usage/help/config 三者一致。
