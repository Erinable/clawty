# 文档总览

这份索引文档用于回答三件事：

1. 先看哪篇文档最快上手。
2. 不同文档各自负责什么，不互相重复。
3. 哪些内容以代码为准，哪些是流程建议。

## 阅读顺序

### 新用户（先跑起来）

1. [README.md](../README.md)
2. [usage.md](./usage.md)
3. [project-status.md](./project-status.md)

### 日常维护者（改代码不走偏）

1. [maintainer-architecture.md](./maintainer-architecture.md)
2. [maintenance-workflow.md](./maintenance-workflow.md)
3. [code-index-release-checklist.md](./code-index-release-checklist.md)

### 排障与稳定性治理

1. [hybrid-degrade-runbook.md](./hybrid-degrade-runbook.md)
2. [db-sync-risk-runbook.md](./db-sync-risk-runbook.md)
3. [hybrid-replay-evaluation.md](./hybrid-replay-evaluation.md)

## 文档分层与职责

- `README.md`
  - 对外入口和 5 分钟上手。
  - 不展开低频细节。

- `docs/usage.md`
  - 用户侧“怎么用”的主手册。
  - 命令、参数、常见工作流。

- `docs/project-status.md`
  - 项目阶段判断和当前主线。
  - 不是 changelog，也不是参数字典。

- `docs/maintainer-architecture.md`
  - 模块职责边界、排查顺序、改动放置规则。

- `docs/maintenance-workflow.md`
  - 日常维护时文档更新、门禁、补测的默认流程。

- `docs/*-runbook.md`
  - 线上/实战排障步骤，按“信号 -> 处置 -> 回归验证”组织。

- `docs/*-evaluation.md` / `docs/*-checklist.md` / `docs/*-roadmap.md`
  - 质量基线、发布门禁与中期规划。

## 可信度约束（避免文档再漂移）

文档中的命令和行为以这三类来源为准：

1. CLI 帮助与解析逻辑：`src/index.js`、`src/*-options.js`
2. 配置默认值：`src/config.js`、`.env.example`、`clawty.config.example.json`
3. 集成与契约测试：`tests/*.test.js`

如果文档与代码冲突，优先修正文档，并在 PR 中注明“对齐点”。
