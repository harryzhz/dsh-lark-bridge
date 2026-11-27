import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  resolveEffectiveAgentRuntime,
  resolveEffectiveCotConfig,
  type LarkBotConfig,
  type LarkGroupConfig,
  type ParsedSlashCommand,
} from '@dsh-lark/lark-core'
import type { IssuedConsoleLoginLink } from './console-login.js'
import type { RuntimeCatalog } from './runtime-catalog.js'
import type { LarkBridgeStore } from './store.js'

/** Everything a slash command needs from the bridge, injected to keep it testable. */
export interface SlashCommandHost {
  readonly ctx: Context
  readonly store: LarkBridgeStore
  readonly runtimes: RuntimeCatalog
  unbindRoute(routeKey: string, options?: { archive?: boolean }): Promise<boolean>
  sessionWebUrl(sessionId: string): string
  issueConsoleLoginLink?(input: {
    readonly botId: string
    readonly botName: string
    readonly adminOpenId: string
  }): IssuedConsoleLoginLink | undefined
  runTurn(agent: Agent, content: ContentBlock[]): Promise<string>
}

export interface SlashCommandInput {
  readonly bot: LarkBotConfig
  readonly group?: LarkGroupConfig
  readonly chatId?: string
  readonly chatType?: 'p2p' | 'group' | string
  readonly senderOpenId?: string
  readonly senderType?: 'user' | 'bot'
  readonly command: ParsedSlashCommand
  readonly routeKey: string
  readonly workingDir: string
  readonly workspaceName: string
  readonly reply: (text: string) => Promise<void>
  readonly sendDirectMessage?: (openId: string, text: string) => Promise<void>
}

const P2P_HELP_TEXT = [
  '可用命令：',
  '/status - 查看当前会话、工作区与接管链接',
  '/cot [on|off|status] - 查看或开关原生思考过程展示',
  '/console - 获取 DSH 管理面一次性登录链接（仅限管理员）',
  '/new - 归档当前会话并开启新会话',
  '/close - 关闭并归档当前会话',
  '/cancel - 中断执行中的任务',
  '/agent <运行时 ID> [启动配置 ID] - 切换智能体默认运行时或启动配置',
  '/model [模型 ID] [思考强度] - 查看可用模型列表或切换当前会话模型',
].join('\n')

const GROUP_HELP_TEXT = [
  '可用命令：',
  '/status - 查看当前会话、工作区与会话链接',
  '/model [模型 ID] [思考强度] - 查看当前会话可用模型，或仅切换当前会话模型（不改群默认配置）',
  '/cot [on|off|inherit|status] - 查看或开关本群思考过程展示（修改仅限管理员）',
  '/console - 私聊获取 DSH 管理面一次性登录链接（仅限管理员）',
  '/new - 归档当前会话并开启新会话',
  '/close - 关闭并归档当前会话',
  '/cancel - 中断执行中的任务',
  '（安全限制：运行时 /agent 配置仅允许在 DSH 控制台或私聊中修改）',
].join('\n')

const GROUP_AGENT_COMMAND_DENIED_TEXT =
  '安全限制：群聊中禁止通过 /agent 修改运行时配置，请在 DSH 控制台或私聊中调整。'

function formatRuntimeWithProfile(presetId: string, profileId?: string): string {
  return profileId ? `${presetId} (${profileId})` : presetId
}

function formatTierBadge(tier: 'lite' | 'standard' | 'heavy' | undefined): string {
  if (tier === 'lite') return '轻量档 (lite)'
  if (tier === 'standard') return '标准档 (standard)'
  if (tier === 'heavy') return '深度档 (heavy)'
  return ''
}

export async function handleSlashCommand(host: SlashCommandHost, input: SlashCommandInput): Promise<void> {
  const { bot, command, routeKey, reply } = input
  const isGroupChat = input.chatType === 'group'
  const binding = host.store.getBinding(routeKey)
  const liveAgent = binding ? host.ctx.agents.get(brandString<SessionId>(binding.sessionId)) : undefined

  switch (command.name) {
    case 'help':
      await reply(isGroupChat ? GROUP_HELP_TEXT : P2P_HELP_TEXT)
      return
    case 'new':
    case 'close': {
      const existed = await host.unbindRoute(routeKey, { archive: true })
      await reply(existed ? '已归档当前会话，下一条消息将开启新会话。' : '当前没有活跃会话。')
      return
    }
    case 'status': {
      const effective = resolveEffectiveAgentRuntime(bot, input.group)
      if (!binding) {
        await reply(
          [
            '当前没有活跃会话',
            `工作区：${input.workspaceName}`,
            `生效运行时：${formatRuntimeWithProfile(effective.agentPreset, effective.runtimeProfileId)}（${effective.model ?? 'default'}${effective.source === 'group' ? ' · 群独立配置' : ''}）`,
            `工作目录：${input.workingDir}`,
          ].join('\n'),
        )
        return
      }
      const selection = liveAgent?.model.current()
      const currentEffort = selection?.reasoningEffort ?? binding.reasoningEffort
      const effortSuffix = currentEffort ? ` (${currentEffort})` : ''
      const tierInfo = formatTierBadge(binding.routedTier)
      await reply(
        [
          `会话：${binding.sessionId}`,
          `工作区：${binding.workspaceName}`,
          `运行时：${formatRuntimeWithProfile(binding.agentPreset, binding.runtimeProfileId)}（${liveAgent?.status ?? '休眠，可恢复'}${binding.runtimePinned ? ' · 会话锁定' : effective.source === 'group' ? ' · 群独立配置' : ''}）`,
          ...(tierInfo ? [`路由档位：${tierInfo}`] : []),
          `模型：${selection ? `${selection.provider}/${selection.model}` : binding.model ?? effective.model ?? 'default'}${effortSuffix}`,
          `工作目录：${binding.workingDir}`,
          `接管链接：${host.sessionWebUrl(binding.sessionId)}`,
        ].join('\n'),
      )
      return
    }
    case 'cancel':
      if (!liveAgent) {
        await reply('当前没有运行中的会话。')
        return
      }
      liveAgent.cancel({ kind: 'user' })
      await reply('已发送中断信号。')
      return
    case 'console':
      await handleConsoleCommand(host, input, isGroupChat)
      return
    case 'cot':
      await handleCotCommand(host, input, isGroupChat)
      return
    case 'agent':
      if (isGroupChat) {
        await reply(GROUP_AGENT_COMMAND_DENIED_TEXT)
        return
      }
      await switchRuntime(host, input)
      return
    case 'model':
      await switchModel(host, input, liveAgent, isGroupChat)
      return
  }
}

async function handleCotCommand(
  host: SlashCommandHost,
  input: SlashCommandInput,
  isGroupChat: boolean,
): Promise<void> {
  const { bot, group, command, reply } = input
  const rawArg = command.args.trim().toLowerCase()
  const effective = resolveEffectiveCotConfig(bot, isGroupChat ? group : undefined)

  if (!rawArg || rawArg === 'status') {
    const scopeDesc = isGroupChat
      ? group?.cotEnabled === 'on'
        ? '本群单独开启'
        : group?.cotEnabled === 'off'
          ? '本群单独关闭'
          : `跟随智能体默认（${bot.cotEnabled ? '开启' : '关闭'}）`
      : `智能体默认（${bot.cotEnabled ? '开启' : '关闭'}）`
    const toolDesc = effective.toolResultEnabled ? '附带工具输出' : '仅展示工具标题'
    await reply(
      [
        `原生思考过程：${effective.enabled ? '已开启' : '已关闭'}（${scopeDesc}）`,
        ...(effective.enabled ? [`工具节点展示：${toolDesc}`] : []),
        isGroupChat
          ? '用法：/cot on | off | inherit | status（修改仅限管理员）'
          : '用法：/cot on | off | status',
      ].join('\n'),
    )
    return
  }

  const normalized =
    rawArg === 'on' || rawArg === 'true' || rawArg === '1'
      ? 'on'
      : rawArg === 'off' || rawArg === 'false' || rawArg === '0'
        ? 'off'
        : rawArg === 'inherit' || rawArg === 'default'
          ? 'inherit'
          : undefined
  if (!normalized || (!isGroupChat && normalized === 'inherit')) {
    await reply(
      isGroupChat
        ? '用法：/cot on | off | inherit | status'
        : '用法：/cot on | off | status',
    )
    return
  }

  if (isGroupChat) {
    const senderOpenId = input.senderOpenId?.trim() || ''
    const admins = bot.adminUsers ?? []
    if ((input.senderType && input.senderType !== 'user') || !senderOpenId) {
      await reply('安全限制：群聊中仅人类管理员可修改 /cot 开关。')
      return
    }
    if (admins.length === 0) {
      await reply(
        `安全限制：尚未为智能体「${bot.name}」配置管理员，请在 DSH 控制台修改本群思考过程开关或先添加管理员。`,
      )
      return
    }
    if (!admins.includes(senderOpenId)) {
      await reply(`安全限制：仅智能体「${bot.name}」配置的管理员可在群聊中修改 /cot 开关。`)
      return
    }
    const targetChatId = input.chatId?.trim() || group?.chatId?.trim() || ''
    if (!targetChatId) {
      await reply('无法识别当前群聊 ID，请在 DSH 控制台修改思考过程开关。')
      return
    }
    const existingGroup = host.store.getGroup(bot.id, targetChatId) ?? group
    host.store.upsertGroup({
      ...(existingGroup ?? { botId: bot.id, chatId: targetChatId, enabled: true }),
      cotEnabled: normalized,
    })
    const label =
      normalized === 'on'
        ? '已为本群开启原生思考过程展示（本群长任务进度提示将自动关闭）'
        : normalized === 'off'
          ? '已为本群关闭原生思考过程展示'
          : `本群已恢复跟随智能体默认（当前为${bot.cotEnabled ? '开启' : '关闭'}）`
    await reply(`${label}，从下一轮对话开始生效。`)
    return
  }

  host.store.upsertBot({
    ...bot,
    cotEnabled: normalized === 'on',
    ...(normalized === 'on' ? { longTurnProgressNotice: false } : {}),
  })
  await reply(
    normalized === 'on'
      ? `已开启智能体「${bot.name}」默认原生思考过程展示，并已自动关闭长任务进度提示，从下一轮对话开始生效。`
      : `已关闭智能体「${bot.name}」默认原生思考过程展示，从下一轮对话开始生效。`,
  )
}

async function handleConsoleCommand(
  host: SlashCommandHost,
  input: SlashCommandInput,
  isGroupChat: boolean,
): Promise<void> {
  const { bot, reply } = input
  const senderOpenId = input.senderOpenId?.trim() || ''
  if ((input.senderType && input.senderType !== 'user') || !senderOpenId) {
    host.store.recordEvent({
      botId: bot.id,
      routeKey: input.routeKey,
      kind: 'command',
      summary: '/console 已拒绝（仅支持人类管理员）',
    })
    await reply('安全限制：/console 仅支持管理员本人触发。')
    return
  }

  const admins = bot.adminUsers ?? []
  if (admins.length === 0) {
    host.store.recordEvent({
      botId: bot.id,
      routeKey: input.routeKey,
      kind: 'command',
      summary: '/console 已拒绝（未配置 adminUsers）',
    })
    await reply(
      `安全限制：尚未为智能体「${bot.name}」配置管理员，请先在 DSH 控制台 → 飞书桥接 → 智能体配置中添加管理员后再使用 /console。`,
    )
    return
  }

  if (!admins.includes(senderOpenId)) {
    host.store.recordEvent({
      botId: bot.id,
      routeKey: input.routeKey,
      kind: 'command',
      summary: '/console 已拒绝（非管理员用户）',
    })
    await reply(`安全限制：仅智能体「${bot.name}」配置的管理员可使用 /console 获取管理面登录链接。`)
    return
  }

  const issued = host.issueConsoleLoginLink?.({
    botId: bot.id,
    botName: bot.name,
    adminOpenId: senderOpenId,
  })
  if (!issued) {
    await reply('当前 DSH 服务未检测到可用的 Web 管理面入口，请确认 dsh web 已启动。')
    return
  }

  const dmBody = [
    `DSH 管理面一次性登录链接（${issued.expiresInSec} 秒内有效，单次使用）：`,
    issued.url,
    '',
    '使用说明：',
    '1. 在目标设备浏览器打开上方链接并点击「确认并登录管理面」；',
    `2. 登录成功后浏览器将保存 30 天登录态，后续直接访问 ${issued.origin} 即可；`,
    '3. 该链接仅限管理员本人使用，请勿转发。',
  ].join('\n')

  if (!isGroupChat) {
    host.store.recordEvent({
      botId: bot.id,
      routeKey: input.routeKey,
      kind: 'command',
      summary: `/console 已向管理员签发一次性登录链接（${issued.expiresInSec}s）`,
    })
    await reply(dmBody)
    return
  }

  if (!input.sendDirectMessage) {
    await reply(`安全限制：管理面登录链接不会发送到群聊，请打开与「${bot.name}」的私聊发送 /console 获取。`)
    return
  }

  try {
    await input.sendDirectMessage(senderOpenId, dmBody)
    host.store.recordEvent({
      botId: bot.id,
      routeKey: input.routeKey,
      kind: 'command',
      summary: `/console 已通过私聊向管理员签发一次性登录链接（${issued.expiresInSec}s）`,
    })
    await reply(
      `已通过私聊向你发送一次性管理面登录链接（${issued.expiresInSec} 秒有效，单次使用），请前往与「${bot.name}」的私聊查看。`,
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    host.store.recordEvent({
      botId: bot.id,
      routeKey: input.routeKey,
      kind: 'command',
      summary: `/console 私聊投递失败：${reason}`,
    })
    await reply(
      `安全限制：管理面登录链接不可发送到群聊，且私聊发送失败（${reason}）。请直接打开与「${bot.name}」的私聊发送 /console 获取。`,
    )
  }
}

function parseAgentCommandArgs(rawArgs: string): {
  readonly runtimeTarget: string
  readonly profileTarget: string
} {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { runtimeTarget: '', profileTarget: '' }
  if (parts.length === 1) {
    const token = parts[0]!
    const colonIdx = token.indexOf(':')
    if (colonIdx > 0 && colonIdx < token.length - 1) {
      return {
        runtimeTarget: token.slice(0, colonIdx).trim(),
        profileTarget: token.slice(colonIdx + 1).trim(),
      }
    }
    return { runtimeTarget: token, profileTarget: '' }
  }
  return {
    runtimeTarget: parts[0]!,
    profileTarget: parts.slice(1).join(' ').trim(),
  }
}

async function switchRuntime(host: SlashCommandHost, input: SlashCommandInput): Promise<void> {
  const { runtimeTarget, profileTarget } = parseAgentCommandArgs(input.command.args)
  const options = await host.runtimes.list()
  const known = options.find((o) => o.id === runtimeTarget)
  if (!known) {
    await input.reply(`用法：/agent <${options.map((o) => o.id).join(' | ')}> [启动配置 ID]`)
    return
  }

  let nextProfileId = ''
  let nextProfileName = ''
  if (profileTarget && profileTarget !== 'default' && profileTarget !== '默认') {
    const profiles = known.profiles ?? []
    const matched = profiles.find(
      (p) =>
        p.id === profileTarget ||
        p.id.toLowerCase() === profileTarget.toLowerCase() ||
        p.name === profileTarget,
    )
    if (!matched) {
      const available = profiles.map((p) => p.id).join(' | ')
      await input.reply(
        available
          ? `运行时 ${known.name} 未找到启动配置 "${profileTarget}"，可用配置：${available}（留空或 default 使用默认配置）`
          : `运行时 ${known.name} 暂无已配置的启动配置，请省略配置参数或先在 DSH 控制台创建。`,
      )
      return
    }
    nextProfileId = matched.id
    nextProfileName = matched.name
  }

  const nextModel = await host.runtimes
    .resolveDefaultModel(known.id, known.defaultModel, nextProfileId || undefined)
    .catch(() => known.defaultModel ?? '')
  const displayTarget = nextProfileName ? `${known.name}（${nextProfileName}）` : known.name

  if (input.group?.runtimeMode === 'override') {
    host.store.upsertGroup({
      ...input.group,
      runtimeMode: 'override',
      agentPreset: known.id,
      runtimeProfileId: nextProfileId,
      model: nextModel,
      reasoningEffort: '',
    })
    await host.unbindRoute(input.routeKey, { archive: true })
    await input.reply(`本群独立运行时已切换为 ${displayTarget}，下一条消息生效。`)
    return
  }
  host.store.upsertBot({
    ...input.bot,
    agentPreset: known.id,
    runtimeProfileId: nextProfileId || undefined,
    model: nextModel || undefined,
    reasoningEffort: undefined,
  })
  await host.unbindRoute(input.routeKey, { archive: true })
  await input.reply(`默认运行时已切换为 ${displayTarget}，下一条消息生效。`)
}

function parseModelCommandArgs(rawArgs: string): {
  readonly modelQuery: string
  readonly effortQuery: string
} {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { modelQuery: '', effortQuery: '' }
  if (parts.length === 1) {
    return { modelQuery: parts[0]!, effortQuery: '' }
  }
  return {
    modelQuery: parts[0]!,
    effortQuery: parts[1]!.toLowerCase(),
  }
}

async function switchModel(
  host: SlashCommandHost,
  input: SlashCommandInput,
  liveAgent: Agent | undefined,
  isGroupChat: boolean,
): Promise<void> {
  const { modelQuery, effortQuery } = parseModelCommandArgs(input.command.args)
  const binding = host.store.getBinding(input.routeKey)
  const effective = resolveEffectiveAgentRuntime(input.bot, isGroupChat ? input.group : undefined)

  if (isGroupChat && !binding) {
    await input.reply(
      '当前话题没有活跃会话：群聊中 /model 仅用于查看或切换当前活跃会话的模型（不修改群默认配置）。请先发起对话后在对应话题内使用。',
    )
    return
  }

  const effectivePreset = binding?.agentPreset ?? effective.agentPreset
  const effectiveProfileId = binding
    ? binding.runtimeProfileId
    : effective.runtimeProfileId
  const runtimeLabel = formatRuntimeWithProfile(effectivePreset, effectiveProfileId)
  const currentSel = liveAgent?.model.current()
  const currentModelId = currentSel?.model ?? binding?.model ?? effective.model ?? ''
  const currentEffort =
    (currentSel?.reasoningEffort ? String(currentSel.reasoningEffort) : undefined) ??
    binding?.reasoningEffort ??
    effective.reasoningEffort ??
    ''

  const emptyCatalog: {
    readonly isExternal: boolean
    readonly provider?: string
    readonly models: readonly {
      readonly id: string
      readonly name: string
      readonly provider?: string
      readonly reasoningEfforts?: readonly string[]
      readonly defaultEffort?: string
    }[]
  } = { isExternal: false, models: [] }
  const catalogResult =
    typeof host.runtimes.listAvailableModelsForPreset === 'function'
      ? await host.runtimes
          .listAvailableModelsForPreset(effectivePreset, effectiveProfileId)
          .catch(() => emptyCatalog)
      : emptyCatalog
  const availableModels = catalogResult.models

  if (!modelQuery) {
    const header = [
      `当前运行时：${runtimeLabel}`,
      `当前模型：${currentModelId || 'default'}${currentEffort ? ` (${currentEffort})` : ''}`,
    ]
    if (availableModels.length === 0) {
      await input.reply(
        [
          ...header,
          '暂未探测到可用模型列表。',
          '用法：/model <模型 ID> [思考强度]',
        ].join('\n'),
      )
      return
    }
    const lines = availableModels.map((m) => {
      const isCur = Boolean(currentModelId && m.id === currentModelId)
      const aliasName = m.name && m.name !== m.id ? ` (${m.name})` : ''
      const efforts =
        m.reasoningEfforts && m.reasoningEfforts.length > 0
          ? ` [${m.reasoningEfforts.join('/')}]`
          : ''
      return `- ${m.id}${aliasName}${efforts}${isCur ? '  ← 当前' : ''}`
    })
    await input.reply(
      [
        ...header,
        '',
        `真实可用模型（共 ${availableModels.length} 个）：`,
        ...lines,
        '',
        isGroupChat
          ? '用法：/model <模型 ID> [思考强度]（仅对当前会话生效，不改群默认配置）'
          : '用法：/model <模型 ID> [思考强度]',
      ].join('\n'),
    )
    return
  }

  const matchedEntry =
    availableModels.find((m) => m.id === modelQuery) ??
    availableModels.find((m) => m.id.toLowerCase() === modelQuery.toLowerCase()) ??
    availableModels.find((m) => m.name.toLowerCase() === modelQuery.toLowerCase())

  if (availableModels.length > 0 && !matchedEntry) {
    const preview = availableModels.map((m) => m.id).join('、')
    await input.reply(
      `运行时 ${runtimeLabel} 下未找到模型 "${modelQuery}"。\n当前真实可用模型：${preview}\n发送 /model 可查看完整列表与支持的思考强度。`,
    )
    return
  }

  const targetModel = matchedEntry?.id ?? modelQuery
  let targetEffort: string | undefined
  if (effortQuery) {
    if (matchedEntry?.reasoningEfforts !== undefined) {
      if (matchedEntry.reasoningEfforts.length === 0) {
        await input.reply(`模型 ${targetModel} 不支持手动调节思考强度，请省略思考强度参数。`)
        return
      }
      const matchedEffort = matchedEntry.reasoningEfforts.find(
        (e) => e.toLowerCase() === effortQuery,
      )
      if (!matchedEffort) {
        await input.reply(
          `模型 ${targetModel} 不支持思考强度 "${effortQuery}"，可选：${matchedEntry.reasoningEfforts.join(' / ')}`,
        )
        return
      }
      targetEffort = matchedEffort
    } else {
      targetEffort = effortQuery
    }
  } else if (matchedEntry?.reasoningEfforts !== undefined) {
    if (matchedEntry.reasoningEfforts.length === 0) {
      targetEffort = undefined
    } else if (currentEffort && matchedEntry.reasoningEfforts.includes(currentEffort)) {
      targetEffort = currentEffort
    } else {
      targetEffort = matchedEntry.defaultEffort
    }
  } else {
    targetEffort = currentEffort || undefined
  }

  const launch = effectivePreset
    ? await host.runtimes
        .resolveAgentLaunch({
          agentPreset: effectivePreset,
          ...(effectiveProfileId ? { runtimeProfileId: effectiveProfileId } : {}),
          explicitModel: targetModel,
          ...(targetEffort ? { explicitReasoningEffort: targetEffort } : {}),
        })
        .catch(() => undefined)
    : undefined
  const provider =
    matchedEntry?.provider ??
    launch?.provider ??
    catalogResult.provider ??
    currentSel?.provider ??
    (binding ? host.runtimes.providerFor(binding.agentPreset) : undefined)

  if (binding) {
    if (liveAgent && provider) {
      try {
        liveAgent.model.select({
          provider,
          model: targetModel,
          ...(targetEffort
            ? { reasoningEffort: brandString<ReasoningEffortId>(targetEffort) }
            : {}),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await input.reply(`切换当前会话模型失败（${runtimeLabel}）：${msg}`)
        return
      }
    }
    host.store.upsertBinding({
      ...binding,
      model: targetModel,
      ...(targetEffort ? { reasoningEffort: targetEffort } : { reasoningEffort: undefined }),
      runtimePinned: true,
    })
    const displayModel =
      matchedEntry?.name && matchedEntry.name !== targetModel
        ? `${matchedEntry.name} (${targetModel})`
        : targetModel
    const effortNote = targetEffort ? ` · 思考强度 ${targetEffort}` : ''
    await input.reply(
      `当前会话模型已切换为 ${displayModel}${effortNote}（仅对本会话生效，不改默认配置；下一轮对话起生效）。`,
    )
    return
  }

  // P2P without active session: keep updating Bot default model (never reached in group chat).
  host.store.upsertBot({
    ...input.bot,
    model: targetModel,
    ...(targetEffort ? { reasoningEffort: targetEffort } : { reasoningEffort: undefined }),
  })
  const effortNote = targetEffort ? `（思考强度 ${targetEffort}）` : ''
  await input.reply(`默认模型已更新为 ${targetModel}${effortNote}`)
}
