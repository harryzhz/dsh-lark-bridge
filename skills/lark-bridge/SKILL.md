---
name: lark-bridge
description: DSH 飞书桥接（dsh-lark-bridge）辅助技能与 CLI。用于在飞书会话或自动化任务中查询当前绑定的智能体与群上下文、获取应用级真实群成员 OpenID（用于 @ 提及）、主动发送图片/文件附件/自定义飞书卡片/进度播报、读取群聊或话题历史消息与被引用消息附件、管理一次性智能跟进提醒事项（reminder）、创建隔离 Git Worktree 分支（worktree），以及管理周期性定时任务（schedule）。
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

`reminder` 单次到期触发后自动归档，默认继承创建会话的群聊/话题或私聊路由：

```bash
# 查看待触发（active）或已归档（archived）提醒事项
lark-bridge reminder list [--status active|archived|all]

# 按指定时间点或相对秒数（--after <sec>）创建核查提醒
lark-bridge reminder create \
  --title "核查下午发版结果" \
  --at "<YYYY-MM-DD HH:mm>" \
  --mention "<open_id>:<负责人>" \
  --prompt "读取本群最新消息与部署记录：已完成或已同步延期则输出 <no_reminder_needed/>；未完成则简短提醒负责人。"

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

# 绑定已有定时任务到指定飞书群或立即试跑
lark-bridge schedule bind <scheduleId> --bot <botId> --chat <chatId> --mode chat --notify non_empty
lark-bridge schedule run <scheduleId>
```
