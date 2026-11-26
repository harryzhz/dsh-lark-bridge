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
3. **按 Conventional Commits 提交、推送分支并发起 Pull Request**：
   - 提交前核对 `git config user.name` 与 `git config user.email` 符合个人公开身份策略。
   - 提交信息使用 `feat(scope): ...`、`fix(scope): ...`、`docs(scope): ...`、`chore(scope): ...` 格式。
   ```bash
   git push -u origin feat/<slug>
   gh pr create --base main
   ```
   - 在 PR 描述中说明变更动机、核心改动、UI 影响（如有）与验证情况，并确保 GitHub CI（`check:privacy`、`build`、`typecheck`、`test`、`pack-bundle`）全部通过。
4. **完成本地端到端真实验证**（见下方第 2 节：优先在独立隔离的本地 E2E 实例挂载当前 PR worktree 产物完成真实浏览器与飞书双机器人实测，未配置隔离 E2E 环境时再回退至飞书触发群或指定验收群；严禁把任何真实群信息、测试机器人 ID 或宿主机路径写入文档、代码或 PR）。
5. **验证与 CI 全通过后合入 `main` 并清理 Worktree（不直接替换正式服务）**：
   - 满足自动合入条件（全量门禁、GitHub CI、飞书端到端实测与浏览器真实验证全部通过；纯文档变更则仅需门禁与 CI 通过）时，**直接合入 `main` 并清理 Worktree**：
   ```bash
   gh pr merge <pr-number> --squash --delete-branch
   cd <主仓库根目录>
   git fetch origin && git checkout main && git pull --ff-only origin main
   git worktree remove .worktrees/<slug>
   git branch -d feat/<slug> 2>/dev/null || true
   git worktree prune
   ```
   - **严禁在日常迭代合入后直接替换或重启正式 DSH Web 服务**；正式环境统一通过 GitHub Release `.tgz` 安装，并在发版后于凌晨低峰或用户显式要求时执行免重启热更新（见第 2.4 节）。

## 2. 交付前端到端真实验证与发布更新规范

单元测试与静态检查不能替代真实运行环境的联调验收。除纯文档修改外，所有需求开发与缺陷修复在交付闭环前，均须在独立隔离的本地 E2E 环境中完成端到端真实验证，通过后再合入 `main`：

### 2.1 隔离 E2E 环境与自动验收群脱敏原则
- **优先使用独立隔离的本地 E2E 实例（推荐）**：在本机维护与正式实例（默认 `~/.dsh`）完全隔离的常驻 E2E DSH Web 实例（独立 `DSH_HOME` 如 `~/.dsh-e2e`、独立端口、独立测试机器人与专用测试群）。`dsh-lark-bridge` 会自动为非默认 `DSH_HOME` 实例隔离私有 `<dataDir>/bin/lark-bridge` 而不覆写宿主机全局 `~/.local/bin/lark-bridge` 与 Skill。PR 验收时直接将 E2E 实例挂载到当前 PR worktree 的构建产物并重启 E2E 服务，全程不中断或污染正式实例；多个并行 worktree 同时进入验收或合入主干阶段时，应通过本机互斥租约锁排队串行占用 E2E 实例与主干构建重启流程（支持崩溃按 PID/TTL 自动回收死锁，避免相互抢占覆盖）。
- **未配置独立 E2E 环境时的回退规则**：
  - **飞书端发起的任务**：默认以当前触发任务所在的飞书群聊/话题作为端到端验收目标，无需再次向用户索要测试群。
  - **用户显式提供了验收群**：自动使用用户提供的验收群执行端到端实测。
  - **其他场景（非飞书发起且未配置 E2E/验收群）**：严禁向非测试业务群发送测试消息，必须先向用户确认专用测试群。
- **严禁落盘群信息与隔离环境标识到仓库**：验收群的名称、`chat_id`、`thread_id`、`message_id`、成员 `open_id`、测试机器人 `app_id`/凭据及宿主机路径仅可在当前任务执行期于内存、本机非默认 `DSH_HOME` 目录或被 gitignore 的 `.local/` 临时目录中使用，**严禁写入任何文档、代码、测试夹具、Commit 信息或 PR 描述**。

### 2.2 真实浏览器 UI 与交互验证（必做）
- 使用真实浏览器（手工打开或无头 Chrome / CDP / Playwright 驱动挂载了当前 PR 构建产物的本地 E2E DSH Web）严格对照 [docs/guidelines/ui.md#8-交付前-ui-验收标准四维硬性门禁](./ui.md#8-交付前-ui-验收标准四维硬性门禁) 完成四维验收，**验收标准不止于「没有 bug、功能正常」，还必须把「简洁美观」与「交互合理」作为同等硬性门禁**：
  - **功能闭环与零异常**：确认浏览器无未捕获 `pageerror`、无 `console.error`、无接口 4xx/5xx 或「历史加载失败」等异常提示；验证改动涉及的配置项编辑、保存、重新打开回显、恢复默认、条件联动展示、列表筛选、删除/清空与「查看」跳转（含活跃、冷会话与归档会话及「对话 / 轨迹」渲染）均正常，且页面加载与切换流畅无明显卡顿。
  - **美感与简洁度视觉复核（必截屏自审）**：涉及界面、图表或样式改动时，**必须截屏审视亮/暗双模式与常规/宽屏视口下的整体观感**——确认画面干净克制、有呼吸感，无「卡片套卡片」、多余提示条、密集文字图表、重复元信息或零值噪声；确认字号层级协调、跨面板风格与语义配色完全统一（零硬编码色值）。
  - **布局对齐与自适应核验**：验证主页 Tab 切换零位移（统一自适应 `.fb-container`，大屏自动展宽、小屏不横向溢出）、图表栅格严格中轴对齐与全宽 SVG `1:1` 清晰渲染、配置项单一控件右对齐、单开关平铺不缩进，以及所有文字/下拉项无截断重叠或滚动条裁切。
  - **交互合理性与数据语义核验**：验证交互作用域符合直觉（局部图表交互只影响当前组件、不造成整页重排跳动，全局筛选归位顶层控制条）、同类功能筛选与反馈全站统一、二级视图原位下钻无双弹框叠层、过程尽量无感且阻塞/失败态有原位可控兜底入口；同时核对所有文案直白克制、指标口径与单位明确、数据维度正交无概念混淆。

### 2.3 真实飞书群端到端实测（涉及消息链路、路由、监听、分流、回复或运行时配置时必做）
- **核心功能端到端闭环**：优先在独立 E2E 专用测试群中通过双机器人模拟发消息（正式侧驱动机器人在测试群禁用入站防循环，主动发送 `@测试机器人` 触发挂载 PR 产物的测试机器人处理）或用户态驱动实测完整链路（入站解析 → 规则路由/智能分流/主动监听判定 → 媒体/引用预取、表情反馈、纯文本或卡片回复、静默跳过 → DSH 会话落盘、自动归档与运行日志/会话列表联动可查看）。
- **配置项真实生效核验**：针对本次新增或改动的每个配置项（如自定义 System Prompt、占位变量替换、上下文条数/窗口开关、群级覆盖/继承/关闭、权限与模型切换等），实际核验保存、回显及在验收群触发时的生效表现，并通过运行日志或落盘会话「轨迹」交叉确认。
- **验证后现场清理**：临时脚本、测试日志与截图统一存于 `.local/`，避免残留无效测试记录或污染日常工作区。

### 2.4 正式环境 GitHub Release 安装与免重启热更新
- 正式 DSH Web 服务应从 GitHub Release `.tgz` 安装并保持 DSH 原生 `hmr` 启用，不再挂载本地开发源码目录：
  - 日常迭代 PR 合入 `main` 后**不直接替换或重启正式 Web**；只要本次相对上一 `v*` tag 包含可发布产物/代码变更，`Release Plugin` workflow 会自动递增版本号（默认 patch，如 `0.4.0 → 0.4.1`；提交信息含 `[minor]` / `[major]` 时对应递增）、验证打包、推送 `vX.Y.Z` tag 并自动发布 GitHub Release（纯文档/CI/单测改动自动跳过，亦可手动 `workflow_dispatch` 或推送 `v*` tag 触发）。正式环境在凌晨低峰自动检查或由负责人显式要求时执行免重启热更新。
  - **UI 一键更新**：在「飞书桥接」工作台顶栏点击版本/更新按钮（或概览页新版本提示），点击「更新」即可原地完成 SHA256 校验、在途任务排空、旧版卸载、新版安装与热重载，无需重启 DSH Web。
  - **CLI 免重启更新**：
    ```bash
    # 查看状态与检测 GitHub Release 新版本
    lark-bridge plugin status --check
    lark-bridge plugin check

    # 宿主机终端直接执行免重启热更新（可指定 bridge | external-agents | all）
    lark-bridge plugin update all

    # 在活跃飞书/Agent 会话内触发时必须追加 --detached 防止自中断
    lark-bridge plugin update all --detached
    ```
- 仅在升级 DSH 本体或修改底层 `cordis.patch.yml` 确需重启正式服务且经负责人确认时，先执行 `lark-bridge lifecycle drain --wait --reason "<reason>"`，排空（`rc=0` 或 `rc=2`）后再重启托管服务并运行 `lark-bridge doctor` 自检。

### 2.5 阻断与边界说明
- **任一环节不通过即阻断**：若 CI 失败、飞书端到端实测失败、浏览器发现 UI 报错或未通过四维 UI 验收门禁（包含设计美感、简洁度、对齐自适应或交互合理性不达标），或 `lifecycle drain` 返回非 `0/2` 异常退出码，必须立即中止自动合入或重启，先修复优化或如实向用户回报失败点。
- **未验证边界透明披露**：若当前会话受限于客观环境条件（如未配置飞书凭据、无浏览器环境），必须在交付说明中明确列出已完成项与未验证边界，**禁止以单元测试通过替代端到端真实验证**。

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
