# Hybrid Replay Evaluation

更新时间：2026-03-03

`hybrid replay` 用于对同一批 query case 按多套策略参数（preset）做离线回放，并输出可对比的质量/降级指标。

默认输入：

- 用例集：`tests/fixtures/hybrid-cases/expected.json`
- 策略集：`tests/fixtures/hybrid-cases/replay-presets.json`
- 基线：`tests/bench/hybrid-replay.baseline.json`

## 常用命令

```bash
npm run bench:hybrid:replay
npm run bench:hybrid:replay:check
npm run bench:hybrid:replay:baseline
npm run bench:hybrid:replay:failure:check
```

原始脚本支持附加参数：

```bash
node tests/bench/hybrid-replay.bench.js --json
node tests/bench/hybrid-replay.bench.js --preset=baseline_fixture,freshness_aggressive
node tests/bench/hybrid-replay.bench.js --query-pattern=cross_file_semantic
node tests/bench/hybrid-replay.bench.js --intent=rerank,degrade_timeout
node tests/bench/hybrid-replay.bench.js --write-failures
node tests/bench/hybrid-replay.bench.js --write-failures --failures-output=/tmp/hybrid-failures.json
node tests/bench/hybrid-replay.bench.js --check-failures
node tests/bench/hybrid-replay.bench.js --check-failures --failures-baseline=/tmp/hybrid-failures.json
node tests/bench/hybrid-replay.bench.js --cases=tests/fixtures/hybrid-cases/expected.json
node tests/bench/hybrid-replay.bench.js --presets=tests/fixtures/hybrid-cases/replay-presets.json
```

## 输出结构

每个 preset 输出：

- `metrics`: 全局质量指标（`primary_top1_rate`、`primary_top3_rate`、`mean_reciprocal_rank`、`task_success_rate` 等）
- `bucket_metrics`: 四类分桶指标
  - `bucket`
  - `language`
  - `file_type`
  - `intent`
  - `query_pattern`
- `score`: 综合分（用于多 preset 排序）

## 基线门禁

`--check-baseline` 会校验每个 preset 的以下指标不低于基线 `threshold_percent`：

- `score`
- `task_success_rate`
- `primary_top1_rate`
- `mean_reciprocal_rank`

若任一指标回退超过阈值，脚本返回非 0 退出码。

## 失败样本导出

`--write-failures` 会导出每个 preset 的失败样本：

- 默认输出：`tests/fixtures/hybrid-cases/failure-samples.json`
- 可通过 `--failures-output=<path>` 覆盖输出路径

失败样本会包含：

- case 基本信息（`name/language/file_type/intent/query_pattern/query`）
- 期望与实际（`primary_rank`、embedding status、degraded flag）
- `failure_reasons` 标签（如 `primary_not_top1`、`embedding_status_mismatch`）

## 新失败门禁

`--check-failures` 会读取 failure baseline（默认 `tests/fixtures/hybrid-cases/failure-samples.json`），并校验当前回放是否出现了 baseline 之外的新失败样本：

- 新失败判定键：`preset + case.name + primary_path`
- 如果仅有历史已知失败，门禁通过
- 如果出现新增失败，脚本返回非 0 退出码
