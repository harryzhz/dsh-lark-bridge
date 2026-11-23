# dsh-lark-bridge

基于 DeepSeek Harness (DSH) 插件体系构建的飞书（Lark）多智能体桥接、群治理与主动协作工作台（支持 DSH Desktop 与 Web；外部 CLI Agent 运行时已拆分至独立配套仓库 `dsh-external-agents`）。

## 开发工作流（默认规则）

- **Worktree + 分支 + PR**：新需求或修复默认基于最新 `origin/main` 在 `.worktrees/<slug>` 新建独立 worktree 与功能分支（如 `feat/<slug>`、`fix/<slug>`、`docs/<slug>`）开发，**禁止直接在 `main` 分支提交**（除非用户明确要求）。完成后推送分支并向 `main` 发起 GitHub PR，合入后清理 worktree 与已合并分支（详见 [docs/guidelines/development.md](./docs/guidelines/development.md)）。
- **产物目录边界**：本仓库研发临时产物放本仓库 `.local/`（已 gitignore）；产品运行产物放 `$DSH_HOME/lark-bridge/`、`<workingDir>/.dsh-lark-bridge/` 与 `<workingDir>/.worktrees/`，**严禁将产品运行产物写入目标工作区的 `.local/`**。
- **合并前门禁**：提交与发起 PR 前必须全部通过：
  ```bash
  pnpm build && pnpm typecheck && pnpm test && pnpm run check:privacy
  ```

## 核心红线（每次必守）

- **防腐层与能力驱动**：`packages/lark-core` 不得依赖任何 `@deepseek-ai/*` 包；桥接层与前端统一经 `RuntimeCatalog` / `/api/lark-bridge/runtimes` 动态读取 DSH 原生预设与可选 `ctx.externalRuntimes`，禁止硬编码引擎分支或各 Agent 私有记忆文件路径。
- **鉴权与会话安全**：`/api/lark-bridge/*` 与 `/api/lark-bridge-rpc` 必须显式执行 `ctx.connection.admit(req)` 或受限 CLI Bearer Token 的 fail-closed 鉴权；敏感端点（如 `/fs/dirs`）严格限定 Owner，绝不向飞书消息泄露主 `launchToken`。
- **UI 规范一致**：修改 `packages/dsh-lark-ui` 必须遵守 [docs/guidelines/ui.md](./docs/guidelines/ui.md)（复用 DSH 原生组件与 `--dsw-*` 令牌、右侧控件单一对齐、禁止同级双弹框叠层）。
- **开源与隐私红线**：仓库面向 GitHub 公开，严禁提交真实凭据、运行期状态文件、真实飞书 ID（`cli_*`/`ou_*`/`oc_*`/`on_*`/`om_*`）、宿主机真实路径、未脱敏媒体资源或非公开内部信息，提交前必过 `pnpm run check:privacy`（详见 [SECURITY.md](./SECURITY.md)）。

## 文档索引（按任务按需阅读）

> 完整目录拓扑、长期活文档与阶段性产物的分类/放置规范见 [docs/README.md](./docs/README.md)。

| 涉及场景 | 文档 | 内容摘要 |
| --- | --- | --- |
| 新建 worktree / 提 PR / 验证发版 / 隐私自检 | [docs/guidelines/development.md](./docs/guidelines/development.md) | Worktree + 分支 + PR 标准流程、Commit 约定、常用脚本与脱敏自检清单 |
| 修改前端界面、弹窗、表单或样式（**必读**） | [docs/guidelines/ui.md](./docs/guidelines/ui.md) | 设计令牌、控件右对齐规范、原位子视图与防双层遮罩、级联子配置与标签流样式 |
| 改动包分层 / 鉴权路由 / Desktop 接管 / 目录边界 | [docs/architecture/overview.md](./docs/architecture/overview.md) | 六大模块分层、能力驱动边界、产物目录、HTTP/RPC 与 Electron Desktop 约束 |
| 改动消息路由、话题复用、代答/监听或自动归档 | [docs/architecture/session-management.md](./docs/architecture/session-management.md) | 五级入站路由、多路由别名索引、`SessionActor` 状态机与典型配置场景 |
| 涉及凭据、权限边界、脱敏示例或漏洞响应 | [SECURITY.md](./SECURITY.md) | 运行期安全架构、开源防泄露基线与漏洞披露流程 |
| 新增文档 / 查阅历史审查与演进背景 | [docs/README.md](./docs/README.md) · [docs/reports/](./docs/reports/2026-11-23-architecture-review.md) | 文档目录与放置约定；已归档的架构审查报告与演进记录 |
