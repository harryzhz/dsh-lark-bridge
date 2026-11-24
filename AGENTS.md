# dsh-lark-bridge

基于 DeepSeek Harness (DSH) 插件体系构建的飞书（Lark）多智能体桥接、群治理与主动协作工作台（支持 DSH Desktop 与 Web；外部 CLI Agent 运行时已拆分至独立配套仓库 `dsh-external-agents`）。

## 开发工作流（默认规则）

- **Worktree + 分支 + PR**：新需求或修复默认基于最新 `origin/main` 在 `.worktrees/<slug>` 新建独立 worktree 与功能分支（如 `feat/<slug>`、`fix/<slug>`、`docs/<slug>`）开发，**禁止直接在 `main` 分支提交**（除非用户明确要求）。完成后推送分支并向 `main` 发起 GitHub PR；验证与 CI 通过后自动合入 `main`、清理 worktree 与已合并分支并按需优雅重启服务（详见 [docs/guidelines/development.md](./docs/guidelines/development.md)）。
- **产物目录边界**：本仓库研发临时产物放本仓库 `.local/`（已 gitignore）；产品运行产物放 `$DSH_HOME/lark-bridge/`、`<workingDir>/.dsh-lark-bridge/` 与 `<workingDir>/.worktrees/`，**严禁将产品运行产物写入目标工作区的 `.local/`**。
- **合并前门禁**：提交与发起 PR 前必须全部通过：
  ```bash
  pnpm build && pnpm typecheck && pnpm test && pnpm run check:privacy
  ```
- **端到端真实验证与自动合入重启**：除纯文档修改外，全量门禁与 PR CI 通过后须在本地运行的 DSH 环境中自动完成真实端到端验证——（1）**飞书端到端实测**：当任务由飞书端发起时默认在当前触发任务所在的飞书群/话题实测，或当用户显式提供了验收群时在提供的群实测（**严禁将任何真实群名称、群 ID 或消息 ID 写入文档、代码、测试或 PR**；未从飞书发起且未指定验收群时须先向用户确认，严禁向非测试业务群发消息）；（2）**真实浏览器验证**：使用真实浏览器访问本地 DSH Web 检查页面渲染、核心交互、配置保存回显、跳转链路与控制台零报错。**上述验证与 CI 全部通过后，无需等待二次确认，直接自动将 PR 合入 `main`、拉取主干重新构建并执行优雅排空重启**（详见 [docs/guidelines/development.md](./docs/guidelines/development.md#2-交付前端到端真实验证与自动合入重启规范)）；任一环节失败则中止合入与重启并回报问题，受环境限制无法完成某项时须显式说明未验证边界，不得以单测替代实测。

## 核心红线（每次必守）

- **防腐层与能力驱动**：`packages/lark-core` 不得依赖任何 `@deepseek-ai/*` 包；桥接层与前端统一经 `RuntimeCatalog` / `/api/lark-bridge/runtimes` 动态读取 DSH 原生预设与可选 `ctx.externalRuntimes`，禁止硬编码引擎分支或各 Agent 私有记忆文件路径。
- **鉴权与会话安全**：`/api/lark-bridge/*` 与 `/api/lark-bridge-rpc` 必须显式执行 `ctx.connection.admit(req)` 或受限 CLI Bearer Token 的 fail-closed 鉴权；敏感端点（如 `/fs/dirs`）严格限定 Owner，绝不向飞书消息泄露主 `launchToken`。
- **UI 规范一致**：修改 `packages/dsh-lark-ui` 必须遵守 [docs/guidelines/ui.md](./docs/guidelines/ui.md)（复用 DSH 原生组件与 `--dsw-*` 令牌、右侧控件单一对齐、禁止同级双弹框叠层）。
- **开源与隐私红线**：仓库面向 GitHub 公开，严禁提交真实凭据、运行期状态文件、真实飞书 ID（`cli_*`/`ou_*`/`oc_*`/`on_*`/`om_*`）、宿主机真实路径、未脱敏媒体资源或非公开内部信息，提交前必过 `pnpm run check:privacy`（详见 [SECURITY.md](./SECURITY.md)）。

## 文档索引（按任务按需阅读）

> 完整目录拓扑、长期活文档与阶段性产物的分类/放置规范见 [docs/README.md](./docs/README.md)。

| 涉及场景 | 文档 | 内容摘要 |
| --- | --- | --- |
| 新建 worktree / 提 PR / 端到端验证 / 隐私自检 | [docs/guidelines/development.md](./docs/guidelines/development.md) | Worktree + 分支 + PR 标准流程、交付前端到端真实验证规范、Commit 约定与脱敏自检清单 |
| 修改前端界面、弹窗、表单或样式（**必读**） | [docs/guidelines/ui.md](./docs/guidelines/ui.md) | 设计令牌、控件右对齐规范、原位子视图与防双层遮罩、级联子配置与标签流样式 |
| 改动包分层 / 鉴权路由 / Desktop 接管 / 目录边界 | [docs/architecture/overview.md](./docs/architecture/overview.md) | 六大模块分层、能力驱动边界、产物目录、HTTP/RPC 与 Electron Desktop 约束 |
| 改动消息路由、话题复用、代答/监听或自动归档 | [docs/architecture/session-management.md](./docs/architecture/session-management.md) | 五级入站路由、多路由别名索引、`SessionActor` 状态机与典型配置场景 |
| 改动 Memory、Dreaming 整理或记忆产物组织 | [docs/architecture/memory-and-dreaming.md](./docs/architecture/memory-and-dreaming.md) | 跨运行时 Memory 数据模型、SQLite v3/FTS5 与 `MEMORY.md` 产物组织、两层渐进披露与 Auto-Dream 四阶段机制 |
| 涉及凭据、权限边界、脱敏示例或漏洞响应 | [SECURITY.md](./SECURITY.md) | 运行期安全架构、开源防泄露基线与漏洞披露流程 |
| 新增文档 / 查阅历史审查与演进背景 | [docs/README.md](./docs/README.md) · [docs/reports/](./docs/reports/2026-11-23-architecture-review.md) | 文档目录与放置约定；已归档的架构审查报告与演进记录 |
