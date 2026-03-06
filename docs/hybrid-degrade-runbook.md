# Hybrid Embedding Degrade Runbook

适用范围：`query_hybrid_index` 的 embedding 二阶段重排异常（`sources.embedding.status_code`）。

## 1. 分流口径

| status_code | 分类 | 是否故障 | 默认动作 |
| --- | --- | --- | --- |
| `EMBEDDING_OK` | ok | 否 | 无需处理 |
| `EMBEDDING_DISABLED` | disabled | 否 | 确认是否为预期开关 |
| `EMBEDDING_NOT_ATTEMPTED_NO_API_KEY` | misconfig | 否 | 检查 key 配置 |
| `EMBEDDING_NOT_ATTEMPTED_NO_CANDIDATES` | no_candidates | 否 | 检查上游召回 |
| `EMBEDDING_ERROR_TIMEOUT` | timeout | 是 | 提高超时 / 降并发 |
| `EMBEDDING_ERROR_NETWORK` | network | 是 | 检查网络与 DNS/TLS |
| `EMBEDDING_ERROR_API` | api | 是 | 检查 provider/配额/鉴权 |
| `EMBEDDING_ERROR_RESPONSE` | response | 是 | 检查响应格式兼容 |
| `EMBEDDING_ERROR_INPUT` | input | 是 | 检查输入长度与清洗 |
| `EMBEDDING_ERROR_UNKNOWN` | unknown | 是 | 先归类再补映射 |

## 2. 诊断步骤

1. `npm run metrics:report -- --json`，查看 embedding 相关 KPI。
2. 检查 `runbook.embedding_unmapped_status_codes` 是否非空。
3. 抽样 `.clawty/metrics/hybrid-query.jsonl` 最近事件，定位 status code 与错误上下文。

## 3. 快速处置

### timeout

- 调大 `CLAWTY_EMBEDDING_TIMEOUT_MS`
- 降低重排候选规模（`embedding_top_k`）
- 紧急情况下临时关闭 embedding

### network

- 校验 `CLAWTY_EMBEDDING_BASE_URL`
- 检查代理、DNS、TLS
- 在 CI/容器复现以排除本地环境因素

### api

- 检查 key、配额、限流
- 检查 provider 服务状态
- 必要时切换模型或 endpoint

### response/input/unknown

- 抽样事件并复现
- 补测试（`tests/tools.test.js`、`tests/metrics-*.test.js`）
- 补 runbook 映射

## 4. 恢复验证

```bash
npm run metrics:check -- --runbook-enforce
npm run bench:hybrid:check
```

确认以下指标回到可接受范围：

- `query_hybrid_p95_ms`
- `degrade_rate`
- `embedding_timeout_rate`
- `embedding_network_rate`
- `embedding_api_rate`
- `embedding_unknown_rate`
