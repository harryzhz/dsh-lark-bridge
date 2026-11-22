# dsh-lark-bridge

基于 DeepSeekHarness (DSH) 插件体系构建的飞书（Lark）多智能体桥接、群治理与主动协作工作台（支持 DSH Desktop 与 Web；外部 CLI Agent 运行时已拆分至独立配套仓库 `dsh-external-agents`）。

## 仓库分层（防腐层架构）

- `packages/lark-core` — 纯 TS 飞书多智能体长连接、开放平台与 OAuth 认证、群路由、`<system_reminder>` / `<user_message>` 合成、监听规则、代答协作、卡片与实验性 Dreaming / 主动工作协议层（零 DSH 依赖）
- `packages/dsh-lark-bridge` — 薄 DSH Host 插件：飞书连接编排（`LarkBridgeManager`）、工程化 `<system_reminder>` 上下文注入、Dreaming 离线记忆整理服务（`DreamingService`）、一次性智能提醒事项服务（`ProactiveReminderService`）、本地目录浏览（`fs-browser`）、运行时目录聚合（`RuntimeCatalog`，可选动态发现 `ctx.externalRuntimes`）、工作区与过期会话自动归档（`WorkspaceGrouping`）、定时任务群通知与上下文注入（`ScheduleNotifier`）、斜杠命令（`slash-commands`）及 Web / Desktop RPC / CLI 鉴权 API
- `packages/dsh-lark-ui` — DSH Client 插件：基于 `@deepseek-ai/dsh-client-ui-primitives` 原生组件构建的概览、智能体、群聊、自动化（提醒事项 + 定时任务）与会话管理界面及悬浮配置窗
- `packages/dsh-bundle` — 自托管 Web Profile 装配工具（`cordis.patch.yml`、`dsh-lark-ctl.mjs`，支持 `--external-agents` 按需叠加独立外部运行时插件）与 Agent 辅助命令行源码（`lark-bridge.mjs`）
- 根包 `dsh-lark-bridge`（`package.json` + `cordis.patch.yml` + `scripts/prepare-root.mjs`）— 面向 DSH Desktop / Web「添加插件」发布的零侵入独立飞书桥接双端 Bundle（整合 Host + Client UI + `lark-bridge` CLI + Skill，支持 npm / Release `.tgz` / Git 直装）
- `skills/lark-bridge` — 配套 `lark-bridge` Agent 技能（`SKILL.md`），自动同步至 `~/.agents/skills/lark-bridge/`

## 工程约束

- 核心协议层（`packages/lark-core`）不得反向依赖任何 `@deepseek-ai/*` 包。
- 业务桥接层与前端统一通过 `RuntimeCatalog` / `/api/lark-bridge/runtimes` 动态读取 DSH 原生预设及可选的 `ctx.externalRuntimes`（由独立配套插件 `dsh-external-agents` 提供），禁止硬编码引擎分支；桥接层同样不得感知或硬编码各 Agent 运行时私有的本地记忆文件路径，统一通过任务提示词触发 Agent 自身的原生记忆机制。
- **产品运行产物目录边界**：`dsh-lark-bridge` 产品运行期及 `lark-bridge` CLI 产生的全局数据统一存放在 `~/.dsh/lark-bridge/`（`$DSH_HOME/lark-bridge`），项目/工作区粒度的产品产物（如消息附件下载等）统一存放在 `<workingDir>/.dsh-lark-bridge/`（自动写入 `.gitignore`），主动代码修改使用的 Git Worktree 统一存放在 `<workingDir>/.worktrees/`（自动写入 `.gitignore`），**严禁将产品运行产物写入目标工作区的 `.local/` 目录**。
- **本仓库研发临时产物**：在开发 `dsh-lark-bridge` 仓库自身时的临时脚本、验证日志与本地测试数据统一放在本仓库 `.local/`（已被 gitignore）。
- 面向 `@deepseek-ai/dsh@0.2.2-rc.5` 的自定义 HTTP 路由（`/api/lark-bridge`）必须显式通过 `ctx.connection.admit(req)` 执行 fail-closed 鉴权；Web 与 Electron Desktop 客户端统一走 `ctx.connection.fetch.register('/api/lark-bridge-rpc')` + `ctx.connection.rpc.call('/api', 'lark-bridge-rpc', ...)` 载体无关通道（兼容 Desktop `file://` 渲染进程与 `__DSH_TRANSPORT__`），宿主机本地目录浏览接口（`/api/lark-bridge/fs/dirs`）严格限定 Owner 会话访问。
- 在 Electron Desktop Host 模式下，`cli-endpoint.json` 由 `bridge-manager.ts` 在 `webServer` 就绪后用 `webServer.getOrigin()` 动态回填以适配 OS 随机端口，`cli-support.ts` 生成的 `lark-bridge` 包装脚本自动注入 `ELECTRON_RUN_AS_NODE=1` 并支持 Windows `.cmd`；同时 loopback 监听下的会话接管链接通过 `/api/lark-bridge/open`（仅 loopback + 进程级随机 HMAC ticket）优先经由桌面端 `dsh-app://app` 渲染进程长轮询通道（`/desktop/open-wait` + `/desktop/open-ack`）直接切至桌面 APP 会话页并通过官方 `dsh://open` 置顶窗口，无桌面窗口或显式 `mode=web` 时平滑回退到同源 HTML 跳转 `ctx.connection.authenticatedUrl` 完成浏览器首跳鉴权，绝不向飞书消息泄露主 `launchToken`，非 loopback（局域网/公网）部署严格禁用该端点。
- 飞书表情反馈资源由 `packages/dsh-lark-ui/scripts/generate-emoji-assets.mjs` 从飞书开放平台官方目录生成。

## UI 设计与交互规范

- **设计令牌与主题一致**：全面复用 `@deepseek-ai/dsh-client-ui-primitives` 原生控件与 `--dsw-*` 主题令牌，自动适配亮/暗双模式，严禁硬编码颜色值或暴露裸 JSON 输入框。
- **级联子配置样式（`<NestedSettings>` / `.fb-nested`）**：
  - 开关或模式展开的二级配置**不加背景底色与圆角框**，右侧控件与一级配置严格右对齐（`padding-right: 0`）；
  - 左侧采用与配置项间横线一致的细引导竖线（`0.5px solid var(--dsw-alias-border-l2)`），高度对齐子配置首尾内容，展开二级配置时自动收起父项底部横线（`.fb-row:has(+ .fb-nested)`）。
- **配置说明与下拉选项克制原则**：
  - 表意自明的配置项（如显示名称、App ID、工作目录、模型、允许私聊、提醒创建方式、分支前缀等）**不加冗余描述**；非自明项仅写单句准确说明，避免长段落堆砌。
  - 表意自明的下拉选项保持紧凑单行菜单，**不给所有下拉项强加副标题**；仅在选项间存在非直观语义差异（如代答身份说明、应用创建通道）时提供单行区分说明。
- **分组机制说明区块**：功能机制介绍区块统一置于对应 `<GroupTitle>` 分组标题正下方，采用无小标题、无列表圆点（bullet）的单段描述，与上下内容之间不加横线分隔；分组标题前的末尾配置项隐藏底部分隔横线（`.fb-row:has(+ .fb-group-title)`）。
- **切换器、状态筛选标签与数量数字**：
  - 视图主切换使用分段控制器（`<CountSegmentedSwitch>` / `SegmentedControl`），高频或基础能力置于左侧（如「自动化」页 `定时任务` 在左、`提醒事项` 在右）。
  - 列表分类/状态筛选对齐 DSH `TaskManagerPage` 轻标签样式（`<FilterTabs>` / `.fb-filter-tab`：`height: 28px; border: 0; border-radius: 14px`，未选中透明底 + `--dsw-alias-label-tertiary` 文字，选中态 `--dsw-alias-interactive-bg-hover` 底 + `--dsw-alias-label-primary` 文字），不使用带深色边框的 `Pill` 胶囊。
  - 切换器与筛选标签内的数量**不加括号 `()`**，统一紧跟文案右侧显示浅灰色等宽数字（`.fb-tab-count`：`color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums`）。
- **单层可编辑标签流**：支持增删改的标签集合（`<EditableScopeList>`）使用单一标签列表（点击文字原位编辑、`×` 移除、行内 `+ 添加`、仅偏离默认值时显示「恢复默认」），禁止同时渲染预设胶囊栏与已选标签栏造成重复。

## 安全与开源隐私规范

本仓库面向 GitHub 公开发布，所有代码、测试、文档、提交说明与媒体资源须严格遵守 [SECURITY.md](./SECURITY.md) 与以下红线：

1. **禁止提交任何非公开信息**：
   - 严禁提交真实密钥、App Secret、OAuth Token、Cookie、Bearer Token、私钥及运行期状态文件（`state.json`、`cli-endpoint.json`、`open-platform-session.json`、`user-oauth-tokens.json`）。
   - 严禁提交真实飞书租户、群聊、成员或应用的真实 ID（`cli_*`、`ou_*`、`oc_*`、`on_*`、`om_*`）、真实姓名、个人邮箱、手机号及宿主机真实绝对路径（如 `/Users/<真实用户名>`）。
   - 严禁提交公司/组织内部系统名称、内部域名、私有 npm registry 镜像源、未公开产品/内部版本代号，以及直接复制自真实生产环境的告警文本、日志、错误码或业务源码文件名/行号。
   - 严禁在注释、测试或文档中提及或暗示任何非公开/内部版本的存在；所有集成均仅基于公开文档化接口表述。
2. **测试夹具与示例脱敏约定**：
   - 飞书 ID 使用语义化短占位符（如 `cli_xxx`、`cli_test`、`ou_owner`、`oc_team`、`om_msg_1`）；
   - 域名使用 RFC 2606 保留域名（`example.com` / `*.example.com`），示例 IP 优先使用回环地址 `127.0.0.1` 或 RFC 5737 文档网段（`192.0.2.x`、`198.51.100.x`、`203.0.113.x`）；
   - 本地路径示例使用 `/Users/demo/...` 或相对路径，人物名称使用虚构占位名（如 `Alex Chen`、`Sam`、`林晓`）。
3. **媒体与锁文件审查**：
   - 新增或更新截图、架构图、演示视频前必须逐帧确认界面内容与 EXIF/容器元数据不含真实账号、工作区路径、群聊消息或真实 `App ID`。
   - 更新 `pnpm-lock.yaml` 时确保仅解析自公开官方 `registry.npmjs.org`，不得带入私有镜像 URL 或内部包。
4. **提交与发布门禁**：
   - 任何提交或 PR 合并前必须通过 `pnpm run check:privacy`（CI 强制执行）；个人开发机可在被 gitignore 的 `.local/privacy-denylist.txt` 中维护本地敏感词/内部域名黑名单，由脚本自动叠加校验，严禁将私有词表提交到仓库。
   - 提交前核对 `git config user.name` 与 `git config user.email` 符合个人公开身份策略；若误提交敏感信息，立即轮换/吊销凭据并清理 Git 历史后再推送。
