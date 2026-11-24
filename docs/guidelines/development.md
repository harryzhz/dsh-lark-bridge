# 开发与协作规范

本文档说明 `dsh-lark-bridge` 的日常分支协作流程、本地验证打包命令与开源隐私提交自检清单。

## 1. Worktree + 分支 + PR 工作流

`main` 分支始终保持可构建、可发布状态。除用户明确指定在当前分支操作外，**所有新需求、Bug 修复、重构与文档变更均默认通过独立 Git Worktree + 功能分支开发，并通过 GitHub PR 合入 `main`**。

### 分支与目录命名

- **Worktree 路径**：统一放在仓库内 `.worktrees/<slug>`（已被 `.gitignore` 与 `vitest.config.ts` 忽略）。
- **分支前缀**：`feat/<slug>`、`fix/<slug>`、`refactor/<slug>`、`docs/<slug>`、`chore/<slug>`。

### 标准步骤

1. **同步远端主干并创建 Worktree 与分支**：
   ```bash
   git fetch origin
   git worktree add .worktrees/<slug> -b feat/<slug> origin/main
   cd .worktrees/<slug>
   pnpm install
   ```
2. **完成开发并运行全量验证门禁**：
   ```bash
   pnpm build && pnpm typecheck && pnpm test && pnpm run check:privacy
   ```
3. **完成本地端到端真实验证**（见下方第 2 节：真实浏览器 UI 检查 + 真实飞书测试群功能与配置生效验证）。
4. **按 Conventional Commits 提交并推送分支**：
   - 提交前核对 `git config user.name` 与 `git config user.email` 符合个人公开身份策略。
   - 提交信息使用 `feat(scope): ...`、`fix(scope): ...`、`docs(scope): ...`、`chore(scope): ...` 格式。
   ```bash
   git push -u origin feat/<slug>
   ```
5. **向 `main` 发起 Pull Request**：
   - 使用 `gh pr create --base main` 或在 GitHub 页面创建 PR，说明变更动机、核心改动、UI 影响（如有）与端到端验证结果。
   - 确保 CI（`check:privacy`、`build`、`typecheck`、`test`、`pack-bundle`）全部通过后再合并到 `main`。
6. **合入后同步主干并清理 Worktree**：
   ```bash
   cd <主仓库根目录>
   git fetch origin && git checkout main && git pull --ff-only origin main
   git worktree remove .worktrees/<slug>
   git branch -d feat/<slug>
   git worktree prune
   ```

## 2. 交付前端到端真实验证规范

单元测试与静态检查不能替代真实运行环境的联调验收。除纯文档修改外，所有需求开发与缺陷修复在交付用户验收前，均须在本地运行的 DSH 环境中完成端到端真实验证：

### 2.1 本地构建部署与服务自检
- 将当前功能分支构建产物（`dist/`）替换至本地 DSH 运行环境并重启服务（原产物可备份至 `.local/`，不污染 `main` 分支）。
- 核对启动日志无报错、SQLite Schema 迁移与既有数据完好、新增或变更的 `/api/lark-bridge/*` 接口返回符合预期。

### 2.2 真实浏览器 UI 与交互验证（涉及前端页面、配置弹窗、样式或会话跳转时必做）
- 使用真实浏览器（手工打开或无头 Chrome / Playwright 驱动本地 DSH Web）访问实际运行中的控制台页面，逐项核验改动涉及的配置页、弹窗、列表与跳转入口：
  - **界面与布局检查**：对照 [docs/guidelines/ui.md](./ui.md) 检查控件右对齐、二级子分组、明暗主题令牌、文字截断与防双层遮罩；必要时截屏逐项核对，排除视觉错位、重叠或显示异常。
  - **交互与持久化闭环**：验证配置项编辑、保存、重新打开回显、恢复默认及条件联动展示均正常；验证列表筛选、删除/清空与「查看」跳转（包含活跃、冷会话与归档会话加载及会话内「对话 / 轨迹」视图渲染）。
  - **零异常基线**：确认浏览器无未捕获 `pageerror`、无 `console.error`、无接口 4xx/5xx 或「历史加载失败」等异常提示。

### 2.3 真实飞书测试群功能与配置生效验证（涉及消息链路、路由、监听、分流、回复或运行时配置时必做）
- **仅在专用飞书测试群验证**（严禁向非测试业务群发送测试消息，若未明确指定测试群则先向用户确认）。
- **核心功能端到端闭环**：在测试群发送真实消息，验证完整链路（入站接收 → 规则路由/智能分流/主动监听判定 → 表情反馈、纯文本或卡片回复、静默跳过 → DSH 会话落盘、自动归档与运行日志/会话列表联动可查看）。
- **配置项真实生效核验**：针对本次新增或改动的每个配置项（如自定义 System Prompt、占位变量替换、上下文条数/窗口开关、群级覆盖/继承/关闭、权限与模型切换等），实际修改保存后在测试群触发真实请求，通过群内实际表现、运行日志与落盘会话的「轨迹」详情交叉核对，确认配置已按预期生效。
- **验证后现场清理**：临时脚本与截图统一存于 `.local/`，避免残留无效测试记录或污染日常工作区。

### 2.4 边界说明
- 若当前会话受限于环境条件（如未配置测试群凭据、无浏览器环境或纯后端重构不涉及 UI/飞书交互），必须在交付说明中明确列出已完成的验证项与未验证边界，并提醒用户补充验收，**禁止以单元测试通过替代端到端真实验证**。

## 3. 常用命令与产物目录

| 命令 | 说明 |
| --- | --- |
| `pnpm build` | 构建各子包并生成根目录双端 DSH Bundle（`dist/index.js`、`dist/client.js`、`dist/lark-bridge.mjs`） |
| `pnpm build:bundle` | 仅执行 `scripts/prepare-root.mjs` 重新打包根目录 Bundle |
| `pnpm typecheck` | 全仓库 TypeScript 类型检查 |
| `pnpm test` | 运行 Vitest 单元测试（自动排除 `.worktrees/**` 与 `.local/**`） |
| `pnpm run check:privacy` | 运行零依赖开源隐私与密钥扫描（CI 强制门禁） |
| `pnpm run pack:bundle` | 生成可发布 `.tgz` 安装包（默认输出至 `.local/`） |
| `pnpm clean` | 清理各子包与根包构建产物 |

- **本仓库研发临时产物**：开发本仓库自身产生的临时脚本、验证日志与本地测试数据统一放在本仓库 `.local/`（已被 gitignore）。
- **产品运行产物边界**：切勿混淆本仓库 `.local/` 与用户工作区目录，产品运行产物路径约束见 [architecture/overview.md](../architecture/overview.md#3-产物目录边界)。
- **文档归档与放置规范**：新增长期规范或阶段性审查/复盘文档时，请按 [docs/README.md](../README.md) 约定的目录与命名归类。

## 4. 开源隐私与提交自检清单

本仓库面向 GitHub 公开发布，完整运行期与开源安全规范见 [SECURITY.md](../../SECURITY.md)。提交代码、测试、文档、配置或媒体资源前逐项确认：

1. **禁止非公开信息与运行期状态文件**：
   - 严禁提交真实密钥、App Secret、OAuth Token、Cookie、Bearer Token、私钥及运行期状态文件（`lark-bridge.db*`、`config.snapshot.json`、`bridge.lock`、`lark-bridge-state*.json`、`state.json`、`cli-endpoint.json`、`open-platform-session.json`、`user-oauth-tokens.json`）。
   - 严禁提交真实飞书租户、群聊、成员或应用的真实 ID（`cli_*`、`ou_*`、`oc_*`、`on_*`、`om_*`）、真实姓名、个人邮箱、手机号及宿主机真实绝对路径（如 `/Users/<真实用户名>`）。
   - 严禁提交公司/组织内部系统名称、内部域名、私有 npm registry 镜像源、未公开产品/内部版本代号，以及直接复制自真实生产环境的告警文本、日志、错误码或业务源码文件名/行号；严禁在注释、测试或文档中提及或暗示任何非公开/内部版本的存在。
2. **测试夹具与示例脱敏约定**：
   - 飞书 ID 使用语义化短占位符（如 `cli_xxx`、`cli_test`、`ou_owner`、`oc_team`、`om_msg_1`）；
   - 域名使用 RFC 2606 保留域名（`example.com` / `*.example.com`），示例 IP 优先使用回环地址 `127.0.0.1` 或 RFC 5737 文档网段（`192.0.2.x`、`198.51.100.x`、`203.0.113.x`）；
   - 本地路径示例使用 `/Users/demo/...` 或相对路径，人物名称使用虚构占位名（如 `Alex Chen`、`Sam`、`林晓`）。
3. **媒体与锁文件审查**：
   - 新增或更新截图、架构图、演示视频前必须逐帧确认界面内容与 EXIF/容器元数据不含真实账号、工作区路径、群聊消息或真实 `App ID`。
   - 更新 `pnpm-lock.yaml` 时确保仅解析自公开官方 `registry.npmjs.org`，不得带入私有镜像 URL 或内部包。
4. **本地叠加密词拦截与误提交应急**：
   - 个人开发机可在被 gitignore 的 `.local/privacy-denylist.txt` 中维护本地敏感词/内部域名黑名单，由 `pnpm run check:privacy` 自动叠加校验（严禁提交到仓库）。
   - 若误提交敏感信息，必须立即轮换/吊销凭据并清理 Git 历史后再推送。
