---
name: lark-bridge
description: DSH 飞书桥接（dsh-lark-bridge）辅助技能与 CLI。用于在飞书会话或自动化任务中查询当前绑定的智能体与群上下文、获取应用级真实群成员 OpenID（用于 @ 提及）、主动发送图片/文件附件/自定义飞书卡片/进度播报、读取群聊或话题历史消息与被引用消息附件、读写跨运行时 Memory 长期记忆（memory）、管理一次性智能跟进提醒事项（reminder）、创建隔离 Git Worktree 分支（worktree），以及管理周期性定时任务（schedule）。
---

# lark-bridge — 飞书桥接工具指南

会话首轮与自动化任务通过两级 `<system_reminder>`（内含 `<role>`、`<proactive>`、`<lark_context>`、`<substitute>`、`<listener>`、`<schedule>`、`<reminder_trigger>`、`<dream_job>` 等子标签）提供会话元数据与协作约束，并通过环境变量注入 `lark-bridge` CLI。

## 一、使用边界

1. **产物目录规范**：
   - 工作区级桥接产物（引用消息附件下载、待上传图表、临时内容文件等）统一写入 `<workingDir>/.dsh-lark-bridge/`（自动写入 `.gitignore`），**禁止写入 `.local/`**。
   - 主动代码修复与优化统一通过 `lark-bridge worktree create <slug>` 在 `<workingDir>/.worktrees/<slug>` 创建隔离分支，**禁止直接修改主工作目录分支**。
2. **输出与主动发送分工**：
   - 常规文字/Markdown 回复直接作为当轮最终响应输出即可，不要再用 `lark-bridge send` 重复发送同一份正文。
   - 仅在发送本地图片/文件附件、原始飞书 Schema 2.0 卡片 JSON、中途阶段播报或跨群/跨人推送时调用 `lark-bridge send`。
   - 仅在旁听监听（`<listener>`）或主动提醒/定时巡检轮次判断**无需向飞书群发送任何消息**时，优先运行 `lark-bridge silence --reason "<简要原因>"`（结构化静默控制面，即便末尾伴随总结说明也不会误发到群），纯文本环境可输出 `<no_reply/>` 或 `<no_reminder_needed/>` 兜底；当用户显式 `@` 提及（`trigger="mention"`）或私聊时禁止静默或输出 `<no_reply/>`，若问题超出角色职责范围请简短礼貌说明职责边界并拒答。

## 二、常用命令速查

### 1. 查询当前上下文、智能体与群聊

```bash
# 查看当前会话绑定的 botId、chatId、话题根消息 ID 及在线智能体/群列表
lark-bridge context

# 列出已接入的智能体或已加入的飞书群聊
lark-bridge bots
lark-bridge chats [--bot <botId>]
```

### 2. 查询群成员与人员 OpenID（按智能体应用隔离）

飞书 `open_id`（`ou_xxx`）按飞书应用隔离：同一人在不同智能体应用下的 `open_id` 不同，禁止混用其他应用的 `open_id` 或编造。

```bash
# 按姓名/邮箱关键词按需查询本群（或指定 --bot / --chat）成员真实 OpenID（推荐，避免大群全量输出）
lark-bridge members --query "<姓名或邮箱>"
lark-bridge members --bot <botId> --chat <chatId> --query "<姓名或邮箱>"

# 确需查看整群成员与应用列表时可省略 --query
lark-bridge members

# 在当前智能体应用视角下搜索人员
lark-bridge users search "<姓名或邮箱>" [--bot <botId>]
```

- 在正文中 `@` 群内成员：`<at id="ou_xxx">姓名</at>`。
- 目标人员不在目标群内时：直接写姓名并标注「（不在本群）」。

### 3. 发送图片、文件附件、卡片或跨群通知

```bash
# 上传本地图片并发送图文混排卡片（可用 ![说明](img:0) 指定位置，省略则附在末尾）
lark-bridge send --image ./.dsh-lark-bridge/tmp/chart.png <<'EOF'
## 指标趋势

![延迟趋势](img:0)

核心接口 P95 已回落至正常区间。
EOF

# 发送二维码等小图（可选 fit_horizontal | medium | small | tiny）
lark-bridge send --image ./.dsh-lark-bridge/tmp/qr.png --image-mode small "请扫码确认"

# 上传并发送本地文件附件
lark-bridge send --file ./.dsh-lark-bridge/tmp/report.pdf "完整报告见附件。"

# 向指定群顶层或指定用户推送通知并 @ 成员
lark-bridge send --bot <botId> --chat <chatId> --top-level --title "巡检通知" --mention "ou_xxx:姓名" --content-file ./.dsh-lark-bridge/tmp/summary.md

# 发送飞书 Schema 2.0 原始卡片 JSON
lark-bridge send --card-file ./.dsh-lark-bridge/tmp/card.json
```

> 多行正文请使用单引号 `<<'EOF'` heredoc 或 `--content-file <UTF-8文件>`，避免在命令行参数中手写字面量 `\n`。

### 4. 读取历史消息与被引用消息（含附件下载）

```bash
# 读取当前话题（或群聊）最近 30 条消息；传 --thread none 读取整群主消息流
lark-bridge history --limit 30
lark-bridge history --thread none --limit 30

# 读取单条消息全文（如 quoted_message_id="om_xxx"），自动下载图片/文件到 .dsh-lark-bridge/attachments/<messageId>/
lark-bridge message om_xxx
lark-bridge message om_xxx --raw --download-dir ./.dsh-lark-bridge/attachments/quoted
```

### 5. 一次性跟进提醒（`reminder`）与隔离工作树（`worktree`）

`reminder` 单次到期触发后自动归档，默认继承创建会话的群聊/话题或私聊路由；**群聊提醒必须至少指定一位主负责人（`--mention <open_id:负责人>`），禁止无 `@` 群发**，有需要周知的发起人或关注人时使用 `--cc <open_id:抄送人>`（可重复传参）。创建前先 `reminder list` 去重，系统硬限制单链最多续查 3 次（普通提醒总跨度 ≤ 6 小时、委派跟进 `--kind delegation` 总跨度 ≤ 24 小时）、单条指令 ≤ 2400 字（禁止用作无限小时级轮询）：

```bash
# 查看待触发（active）或已归档（archived）提醒事项
lark-bridge reminder list [--status active|archived|all]

# 按时间点核查（群聊必填 --mention 负责人，可选 --cc 抄送关注人）
lark-bridge reminder create \
  --title "核查下午发版结果" \
  --at "<YYYY-MM-DD HH:mm>" \
  --mention "<open_id>:<负责人>" \
  [--cc "<open_id>:<关注人>"] \
  --prompt '运行 lark-bridge history --limit 20 并检查部署状态：已完成或群内已同步延期则调用 lark-bridge silence --reason "已闭环" 静默；未完成则简短提醒负责人并 cc 关注人。'

# 群内 A@B 委派事项跟进（--kind delegation；无明确时间则紧急故障 600s、常规协作/CR/审批 3600s）
lark-bridge reminder create \
  --kind delegation \
  --title "跟进 PR 评审与合入" \
  --after 3600 \
  --mention "<B_open_id>:<负责人B>" \
  --cc "<A_open_id>:<发起人A>" \
  --prompt '同时运行 lark-bridge history --limit 20 与 lark-bridge history --thread none --limit 20 检查进展：已闭环则调 lark-bridge silence 静默；若 B 已回应（如“收到/在看”）但尚未给出结果则顺延复查并静默；仍无进展则温和提醒 B 并 cc A。'

# 按相对秒数复查（P0 紧急止损复查需穿透免打扰时加 --urgency high）
lark-bridge reminder create \
  --title "复查降级恢复情况" \
  --after 1800 \
  --mention "<open_id>:<值班负责人>" \
  [--cc "<open_id>:<关注人>"] \
  [--urgency high] \
  --prompt '检查近 30 分钟错误率与群内通报：指标已恢复且无遗留开关则调用 lark-bridge silence --reason "指标已恢复" 静默；异常持续则同步数据提醒值班人。'

# 关联隔离工作树分支/PR 做错峰提审提醒
lark-bridge reminder create \
  --title "提审修复分支" \
  --at "<YYYY-MM-DD 10:00>" \
  --mention "<open_id>:<评审负责人>" \
  --worktree "<workingDir>/.worktrees/<slug>" \
  --branch "agent/<slug>" \
  [--pr "<prUrl>"] \
  --prompt "确认分支状态并向负责人发起评审。"

# 提前闭环时取消后续冗余提醒
lark-bridge reminder cancel <reminderId>

# 在 <workingDir>/.worktrees/<slug> 创建隔离 Git Worktree 分支
lark-bridge worktree create <slug> --prefix agent/
lark-bridge worktree list
```

### 6. 管理周期性定时任务（`schedule`）

```bash
# 查看所有周期性定时任务及飞书群绑定
lark-bridge schedule list

# 创建周期性定时任务（默认继承当前会话/群聊/智能体的工作目录、运行时与通知群）
lark-bridge schedule create \
  --title "每日服务巡检" \
  --weekly "1,2,3,4,5@09:30" \
  --tz Asia/Shanghai \
  --prompt-file ./.dsh-lark-bridge/tmp/patrol-prompt.md

# 修改已有定时任务的时间规则、标题、提示词、目录/预设或暂停/恢复
lark-bridge schedule update <scheduleId> --daily 07:00 --tz Asia/Shanghai
lark-bridge schedule update <scheduleId> --pause
lark-bridge schedule update <scheduleId> --resume

# 删除周期性定时任务（同时清理飞书群通知绑定）
lark-bridge schedule delete <scheduleId>

# 绑定已有定时任务到指定飞书群或立即试跑
lark-bridge schedule bind <scheduleId> --bot <botId> --chat <chatId> --mode chat --notify non_empty
lark-bridge schedule run <scheduleId>
```

### 7. 跨运行时长期记忆（`memory`）

Memory 为所有原生与外部运行时提供统一的长期记忆库（四类分类：`feedback` 纠偏规则、`user` 用户偏好、`project` 项目决策、`reference` 外部指针；三级作用域：`bot` 全局、`chat` 群聊、`workspace` 工作区；支持双时态纠偏 `supersede`）。新会话首轮 `<memory>` 仅注入极简标题目录、当前话题命中的高相关要点与只读镜像 `MEMORY.md` 路径；写入时请将 `--title` 写为自包含核心结论或触发词（建议 ≤ 35 字）：

```bash
# 列出或检索记忆（默认按当前会话自动推断 --bot；支持中文与英文关键词）
lark-bridge memory list [--bot <botId>] [--scope bot|chat|workspace] [--type feedback|user|project|reference] [--status active|superseded|archived|all]
lark-bridge memory search "<关键词>" [--bot <botId>] [--limit 20]
lark-bridge memory get <memoryId>

# 新增或按同标题幂等更新（仅沉淀高价值隐性认知，不抄录源码/文档已有静态信息）
lark-bridge memory upsert \
  --type feedback \
  --title "发布前必须核对灰度指标" \
  --content "团队要求每次发版先看核心接口 P95 与错误率 10 分钟再推进全量。" \
  [--scope bot|chat|workspace] [--scope-id <id>] [--tags "release,ops"] [--pin]

# 事实被推翻或路径变更时做双时态纠偏（非破坏式替代旧结论）
lark-bridge memory supersede <oldMemoryId> \
  --reason "2026-11-24 已迁移至统一网关鉴权" \
  --type project --title "<新标题>" --content "<新结论>"

# 归档彻底过期或已闭环的临时记忆
lark-bridge memory forget <memoryId> --reason "临时迁移窗口已结束"
```

### 8. 结构化静默、存储迁移维护与健康自检

```bash
# 旁听监听或提醒轮次明确不发送飞书消息（彻底阻断尾部解释文本误发）
lark-bridge silence --reason "常规确认消息，无需介入"

# SQLite 存储状态、预演迁移、完整性校验、热备份、脱敏导出、压缩与回滚
lark-bridge db status
lark-bridge db migrate --dry-run
lark-bridge db verify --against ~/.dsh/lark-bridge/backups/<pre-sqlite-backup>.json
lark-bridge db backup
lark-bridge db export --redact --out ./.dsh-lark-bridge/tmp/redacted-state.json
lark-bridge db compact

# 一键离线+在线健康诊断（SQLite 完整性、实例锁、ACK 延迟、跨主机多实例冲突告警）
lark-bridge doctor
```
