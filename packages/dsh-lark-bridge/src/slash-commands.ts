import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  resolveEffectiveAgentRuntime,
  type LarkBotConfig,
  type LarkGroupConfig,
  type ParsedSlashCommand,
} from '@dsh-lark/lark-core'
import type { RuntimeCatalog } from './runtime-catalog.js'
import type { LarkBridgeStore } from './store.js'

/** Everything a slash command needs from the bridge, injected to keep it testable. */
export interface SlashCommandHost {
  readonly ctx: Context
  readonly store: LarkBridgeStore
  readonly runtimes: RuntimeCatalog
  unbindRoute(routeKey: string, options?: { archive?: boolean }): Promise<boolean>
  sessionWebUrl(sessionId: string): string
  runTurn(agent: Agent, content: ContentBlock[]): Promise<string>
}

export interface SlashCommandInput {
  readonly bot: LarkBotConfig
  readonly group?: LarkGroupConfig
  readonly command: ParsedSlashCommand
  readonly routeKey: string
  readonly workingDir: string
  readonly workspaceName: string
  readonly reply: (text: string) => Promise<void>
}

const HELP_TEXT = [
  '可用命令：',
  '/status - 查看当前会话、工作区与接管链接',
  '/new - 归档当前会话并开启新会话',
  '/close - 关闭并归档当前会话',
  '/cancel - 中断执行中的任务',
  '/agent <运行时 ID> - 切换智能体默认运行时',
  '/model <模型 ID> - 切换当前会话模型',
].join('\n')

export async function handleSlashCommand(host: SlashCommandHost, input: SlashCommandInput): Promise<void> {
  const { bot, command, routeKey, reply } = input
  const binding = host.store.getBinding(routeKey)
  const liveAgent = binding ? host.ctx.agents.get(brandString<SessionId>(binding.sessionId)) : undefined

  switch (command.name) {
    case 'help':
      await reply(HELP_TEXT)
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
            `生效运行时：${effective.agentPreset}（${effective.model ?? 'default'}${effective.source === 'group' ? ' · 群独立配置' : ''}）`,
            `工作目录：${input.workingDir}`,
          ].join('\n'),
        )
        return
      }
      const selection = liveAgent?.model.current()
      await reply(
        [
          `会话：${binding.sessionId}`,
          `工作区：${binding.workspaceName}`,
          `运行时：${binding.agentPreset}（${liveAgent?.status ?? '休眠，可恢复'}${effective.source === 'group' ? ' · 群独立配置' : ''}）`,
          `模型：${selection ? `${selection.provider}/${selection.model}` : binding.model ?? effective.model ?? 'default'}`,
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
    case 'agent':
      await switchRuntime(host, input)
      return
    case 'model':
      await switchModel(host, input, liveAgent)
      return
  }
}

async function switchRuntime(host: SlashCommandHost, input: SlashCommandInput): Promise<void> {
  const target = input.command.args.trim()
  const options = await host.runtimes.list()
  const known = options.find((o) => o.id === target)
  if (!known) {
    await input.reply(`用法：/agent <${options.map((o) => o.id).join(' | ')}>`)
    return
  }
  const nextModel = await host.runtimes
    .resolveDefaultModel(known.id, known.defaultModel)
    .catch(() => known.defaultModel ?? '')
  if (input.group?.runtimeMode === 'override') {
    host.store.upsertGroup({
      ...input.group,
      runtimeMode: 'override',
      agentPreset: known.id,
      model: nextModel,
      reasoningEffort: '',
    })
    await host.unbindRoute(input.routeKey, { archive: true })
    await input.reply(`本群独立运行时已切换为 ${known.name}，下一条消息生效。`)
    return
  }
  host.store.upsertBot({ ...input.bot, agentPreset: known.id, model: nextModel, reasoningEffort: '' })
  await host.unbindRoute(input.routeKey, { archive: true })
  await input.reply(`默认运行时已切换为 ${known.name}，下一条消息生效。`)
}

async function switchModel(host: SlashCommandHost, input: SlashCommandInput, liveAgent: Agent | undefined): Promise<void> {
  const model = input.command.args.trim()
  if (!model) {
    await input.reply('用法：/model <模型 ID>')
    return
  }
  const binding = host.store.getBinding(input.routeKey)
  const effectivePreset =
    binding?.agentPreset ??
    (input.group?.runtimeMode === 'override' ? input.group.agentPreset : undefined) ??
    input.bot.agentPreset
  const launch = effectivePreset
    ? await host.runtimes
        .resolveAgentLaunch({
          agentPreset: effectivePreset,
          explicitModel: model,
        })
        .catch(() => undefined)
    : undefined
  const provider =
    launch?.provider ??
    liveAgent?.model.current()?.provider ??
    (binding ? host.runtimes.providerFor(binding.agentPreset) : undefined)
  if (liveAgent && provider) {
    liveAgent.model.select({ provider, model })
    if (input.group?.runtimeMode === 'override') {
      host.store.upsertGroup({ ...input.group, model })
    }
    await input.reply(`当前会话模型已切换为 ${model}`)
    return
  }
  if (input.group?.runtimeMode === 'override') {
    host.store.upsertGroup({ ...input.group, model })
    await input.reply(`本群独立模型已更新为 ${model}`)
    return
  }
  host.store.upsertBot({ ...input.bot, model })
  await input.reply(`默认模型已更新为 ${model}`)
}
