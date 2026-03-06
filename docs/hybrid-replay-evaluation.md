# Hybrid Replay Evaluation

`hybrid replay` 用于在同一批 query case 上比较多套策略参数（preset），并输出可对比的质量/降级指标。

## 1. 默认输入

- 用例：`tests/fixtures/hybrid-cases/expected.json`
- 预设：`tests/fixtures/hybrid-cases/replay-presets.json`
- 基线：`tests/bench/hybrid-replay.baseline.json`
- 失败样本基线：`tests/fixtures/hybrid-cases/failure-samples.json`

## 2. 常用命令

```bash
npm run bench:hybrid:replay
npm run bench:hybrid:replay:coverage
npm run bench:hybrid:replay:check
npm run bench:hybrid:replay:baseline
npm run bench:hybrid:replay:failures
npm run bench:hybrid:replay:failure:check
npm run bench:hybrid:replay:suite
```

## 3. 常见参数（脚本级）

```bash
node tests/bench/hybrid-replay.bench.js --json
node tests/bench/hybrid-replay.bench.js --preset=baseline_fixture,freshness_aggressive
node tests/bench/hybrid-replay.bench.js --query-pattern=cross_file_semantic
node tests/bench/hybrid-replay.bench.js --intent=rerank,degrade_timeout
node tests/bench/hybrid-replay.bench.js --write-failures --failures-output=/tmp/hybrid-failures.json
node tests/bench/hybrid-replay.bench.js --check-failures --failures-baseline=/tmp/hybrid-failures.json
```

## 4. 输出结构

每个 preset 输出：

- `metrics`：全局质量指标
- `bucket_metrics`：按 `language` / `file_type` / `intent` / `query_pattern` 分桶
- `score`：综合分，用于 preset 排序

## 5. 门禁口径

`bench:hybrid:replay:coverage` 默认校验：

- case 数量与分桶覆盖（`language` / `intent` / `query_pattern` / `file_type`）
- failure samples 基线数量
- case/failure schema 完整性和重复键

`--check-baseline` 默认校验：

- `score`
- `task_success_rate`
- `primary_top1_rate`
- `mean_reciprocal_rank`

若任一指标相对 baseline 回退超过阈值，返回非 0。

## 6. 失败样本治理

`--write-failures` 导出当前失败样本；`--check-failures` 阻止新增未登记失败。

推荐流程：

1. 先 `bench:hybrid:replay`
2. 再 `bench:hybrid:replay:coverage`
3. 再 `bench:hybrid:replay:check` + `bench:hybrid:replay:failure:check`
4. 必要时更新 baseline 与 failure samples，并在 PR 写明原因

可直接执行：

```bash
npm run bench:hybrid:replay:suite
```
