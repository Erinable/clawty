# Code Index Semantic Evaluation (Phase 0)

本文件定义“深度语义推理”路线图的第 0 阶段验收基线：先统一任务集与 KPI，再推进索引能力演进。

## 目标

- 用固定语义任务集评估代码索引对多跳代码理解的支持度。
- 在每次核心索引变更后，量化质量变化，避免“性能提升但语义退化”。

## 数据集

- 夹具目录：`tests/fixtures/semantic-cases/`
- 输入代码：`tests/fixtures/semantic-cases/input/`
- 任务定义：`tests/fixtures/semantic-cases/expected.json`
- 当前覆盖的语义链路：
  - API -> Service -> Gateway 调用链
  - 配置定义 -> 使用链路
  - Worker 重试策略链路
  - 鉴权校验链路
  - 用户资料写入链路

## 执行命令

```bash
npm run bench:semantic
npm run bench:semantic:check
npm run bench:semantic:baseline
```

## 质量指标（越高越好）

- `task_success_rate`：任务成功率（主路径 Top3 且证据召回 >= 50%）
- `primary_top1_rate`：主路径 Top1 命中率
- `primary_top3_rate`：主路径 Top3 命中率
- `mean_reciprocal_rank`：主路径 MRR
- `evidence_recall_at_k`：任务证据路径召回率

附带观测项（不作门禁）：`query_avg_ms`、`query_p95_ms`、`build_ms`。

## 门禁策略

- `bench:semantic:check` 默认阈值 `5%`。
- 若核心质量指标任一低于基线允许下限，命令返回非零并阻止合并。
- 有意变更排序/召回策略时，先评估后更新基线。
