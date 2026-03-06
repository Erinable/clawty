# Code Index Semantic Evaluation

本文定义语义任务评测的目标、数据集和门禁口径，用于避免“性能提升但语义退化”。

## 1. 评测目标

- 量化代码索引对多跳语义任务的支持度。
- 在每次检索主链路改动后进行可比对评估。

## 2. 数据集

- 用例定义：`tests/fixtures/semantic-cases/expected.json`
- 输入代码：`tests/fixtures/semantic-cases/input/`

当前覆盖示例：

- API -> Service -> Gateway 调用链
- 配置定义 -> 使用链路
- Worker 重试链路
- 鉴权校验链路

## 3. 执行命令

```bash
npm run bench:semantic
npm run bench:semantic:check
npm run bench:semantic:baseline

npm run bench:graph
npm run bench:graph:check
npm run bench:graph:baseline

npm run bench:graph:refresh
npm run bench:graph:refresh:check
npm run bench:graph:refresh:baseline
```

补充回退链路测试：

```bash
node --test tests/semantic-graph.test.js
node --test tests/tools.test.js
```

## 4. 核心指标

- `task_success_rate`
- `primary_top1_rate`
- `primary_top3_rate`
- `mean_reciprocal_rank`
- `evidence_recall_at_k`

观测项（不作硬门禁）：`query_avg_ms`、`query_p95_ms`、`build_ms`。

## 5. 门禁策略

- `bench:semantic:check` 默认阈值 `5%`
- `bench:graph:refresh:check` 默认阈值 `2%`
- 若核心指标低于阈值，命令应返回非 0

仅当有意策略变化时更新 baseline，并在 PR 说明 trade-off。
