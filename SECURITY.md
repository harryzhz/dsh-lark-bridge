# 安全与隐私规范（Security & Privacy Policy）

本文档说明 `dsh-lark-bridge` 的运行期安全边界、本地数据隐私原则、开源仓库防泄露规范及安全漏洞响应流程。

## 1. 运行期数据隐私与安全架构

`dsh-lark-bridge` 是运行在用户本地宿主机的 DeepSeek Harness（DSH）插件，遵循**本地优先、最小权限与零遥测**原则：

- **零遥测与无第三方中转**：本插件不收集任何使用遥测数据，不向除用户主动连接的飞书开放平台官方接口（`open.feishu.cn`、`accounts.feishu.cn`、`ask.feishu.cn`）及本地 DSH 宿主之外的任何第三方服务器发送配置、消息或代码内容。
- **本地存储与严格文件权限**：
  - 全局状态与敏感凭据统一存储在 `$DSH_HOME/lark-bridge/`（默认 `~/.dsh/lark-bridge/`），包括 `lark-bridge.db`（SQLite WAL 主库）、`config.snapshot.json`、`bridge.lock`、`open-platform-session.json`、`user-oauth-tokens.json`、`cli-endpoint.json`（及迁移前的旧版 `lark-bridge-state.json` 备份）。
  - 数据目录以 `0o700` 创建，凭据与状态文件均以 `0o600` 权限原子写入（POSIX 平台）。
  - 工作区级附件下载与临时文件隔离写入 `<workingDir>/.dsh-lark-bridge/`，主动代码修改隔离在 `<workingDir>/.worktrees/`，均自动加入目标仓库 `.gitignore`。
- **密钥隔离边界**：
  - 面向前端控制台返回的视图经 `toPublicBotView()` 脱敏，不回传 `larkAppSecret` 明文。
  - 面向 Agent 会话注入的 `lark-bridge` CLI 仅持有本地受限 Bearer Token（`timingSafeEqual` 校验），严禁访问 `/api/lark-bridge/auth/*`、`bots` 写接口与任何飞书应用密钥或用户 OAuth Token。
- **鉴权与会话接管边界**：
  - `/api/lark-bridge/*` 与 `/api/lark-bridge-rpc` 默认 fail-closed，必须通过 DSH `ctx.connection.admit(req)` 或本地 CLI Bearer Token 鉴权，写操作额外执行同源（Origin/Host）校验。
  - 宿主机本地目录浏览接口（`/api/lark-bridge/fs/dirs`）、只读链接密钥重置接口（`/api/lark-bridge/viewer/rotate-secret`）与桌面端会话打开通道（`/api/lark-bridge/desktop/*`）严格限定为 Owner 会话访问。
  - **纯 loopback（本机 Desktop / 本地 Web）**：`/api/lark-bridge/open` 使用进程级 32 字节随机密钥签发的 HMAC-SHA256 票据，优先唤起桌面端或经同源跳转完成 Owner 鉴权，绝不向飞书消息泄露 DSH 主 `launchToken`。
  - **非 loopback（局域网 / 服务器 / 反向代理）**：`/api/lark-bridge/open` 绝不签发 `launchToken`。已认证的 Owner 点击后直接跳转进入完整会话；未登录的群成员仅在持有对应会话的有效 HMAC 票据且对应智能体/群聊开启「允许群成员只读查看」时，通过 DSH 原生 `RemoteAccessService`（`lark-viewer` 只读策略）进入单会话只读视图（仅可见该单会话实时内容，无权发送消息、取消运行、查看其他会话/Dreaming 会话或修改任何 DSH/飞书桥接配置），管理员可随时在控制台一键重置签名密钥令全部历史分享链接立即失效。
  - **群内指令与卡片按钮权限收紧**：飞书群聊内禁止执行会修改全局/群运行时配置的 `/agent`、`/model` 指令；群内提醒事项卡片的确认/取消按钮默认 fail-closed，仅允许智能体配置的 `adminUsers` 点击（未配置管理员时提示在 DSH 控制台处理）。

### 部署建议

- 如需在局域网或反向代理后暴露 DSH Web 服务，请配合 HTTPS 与可信反向代理鉴权，并避免将 `lark-bridge.db*`、`config.snapshot.json`、`bridge.lock`、`lark-bridge-state*.json`、`cli-endpoint.json`、`open-platform-session.json`、`user-oauth-tokens.json` 同步到云盘或纳入版本控制。
- 为飞书自建应用按最小必要范围配置可见成员与群权限；不再使用时可随时在「飞书认证」中撤销用户 OAuth 授权或登出开放平台会话。

## 2. 开源仓库防泄露规范（面向贡献者）

在向本仓库提交代码、测试、文档、配置或媒体资源时，必须遵守以下隐私基线：

| 类别 | 严禁提交 | 合规替代方式 |
| --- | --- | --- |
| 密钥与凭据 | App Secret、API Key、OAuth Token、Cookie、Bearer Token、私钥（`.pem`/`.key`）、`.env` | 使用环境变量占位或测试桩字符串（如 `sec_test`） |
| 平台真实标识 | 真实飞书 `cli_*` / `ou_*` / `oc_*` / `on_*` / `om_*` ID、真实租户/群/成员名 | 使用语义化短占位符（如 `cli_xxx`、`ou_owner`、`oc_team`、`om_msg_1`） |
| 个人隐私信息 | 宿主机真实路径（`/Users/<真实名>`）、未授权个人邮箱、手机号、真实联系人信息 | 使用 `/Users/demo/...`、RFC 2606 保留域名（`example.com`）与虚构名称 |
| 组织/公司非公开信息 | 内部系统名、内部域名、私有 npm registry 源、真实线上告警/日志/源码路径与行号 | 使用完全虚构的通用业务场景与官方公开接口 |
| 媒体与构建产物 | 未脱敏的真实桌面/聊天截图与录屏、含敏感 EXIF 元数据的图片、本地 `.tgz` 与运行日志 | 使用合成/脱敏演示数据并检查媒体元数据 |

### 自动化检查

仓库内置零依赖隐私与密钥扫描脚本，所有 PR 与 `main` 分支推送均由 CI 自动执行：

```bash
pnpm run check:privacy
```

贡献者可在本地（已被 `.gitignore` 忽略）创建 `.local/privacy-denylist.txt`，每行填写需要额外拦截的个人姓名、组织内部域名或内部代号（支持 `#` 注释行与 `/regex/flags` 语法）。脚本会自动加载该本地文件进行叠加检查，从而在不向公开仓库暴露任何敏感词的前提下实现强拦截。

## 3. 安全漏洞与敏感信息披露

如果您发现了本项目的安全漏洞，或发现仓库代码/文档/媒体资源中意外包含敏感信息：

1. **请勿在公开 GitHub Issue 或 Pull Request 中直接披露细节。**
2. 请优先通过本仓库 GitHub 页面 **Security → Advisories → Report a vulnerability** 提交私密安全报告，说明受影响版本、复现步骤与潜在影响。
3. 如维护者不慎向公开历史提交了凭据，请第一时间在对应平台**吊销并轮换凭据**（不可仅依赖覆盖提交），随后再清理 Git 历史并通知受影响方。
