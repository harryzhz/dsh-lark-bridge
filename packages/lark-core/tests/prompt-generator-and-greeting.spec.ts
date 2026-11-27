import { describe, expect, it } from 'vitest'
import {
  LarkBotConfigSchema,
  buildDefaultNewBotSettings,
  buildNewGroupGreetingText,
  buildPromptGenerationMessages,
  parseGeneratedListenerOutput,
  parseGeneratedRoleOutput,
} from '../src/index.js'

describe('new group defaults and greeting text', () => {
  it('enables auto-enable and greeting by default in schema and new bot defaults', () => {
    const parsed = LarkBotConfigSchema.parse({
      id: 'demo-bot',
      name: 'Demo Bot',
      larkAppId: 'cli_test_app',
      larkAppSecret: 'secret_demo',
      defaultWorkingDir: '/tmp/demo',
    })
    expect(parsed.autoEnableNewGroup).toBe(true)
    expect(parsed.newGroupGreetingEnabled).toBe(true)
    expect(parsed.newGroupGreetingMessage).toBe('')

    const defaults = buildDefaultNewBotSettings()
    expect(defaults.autoEnableNewGroup).toBe(true)
    expect(defaults.newGroupGreetingEnabled).toBe(true)
    expect(defaults.newGroupGreetingMessage).toBe('')
  })

  it('builds default greeting with bot name, enabled role, description, and chat name', () => {
    const text = buildNewGroupGreetingText(
      {
        name: '研发助手',
        description: '负责代码审查与排障协作\n第二行不展示',
        role: { enabled: true, name: '研发搭档', systemPrompt: '...' },
        newGroupGreetingMessage: '',
      },
      { chatName: '工程协作群' },
    )
    expect(text).toContain('研发助手（研发搭档）')
    expect(text).toContain('「工程协作群」')
    expect(text).toContain('负责代码审查与排障协作')
    expect(text).not.toContain('第二行不展示')
    expect(text).toContain('@我')
  })

  it('renders custom greeting templates with bot_name and chat_name placeholders', () => {
    const text = buildNewGroupGreetingText(
      {
        name: '值班机器人',
        description: '',
        role: { enabled: false, name: '', systemPrompt: '' },
        newGroupGreetingMessage: 'Hi {{chat_name}}，我是 {{bot_name}}，随时 @ 我！',
      },
      { chatName: '告警值班群' },
    )
    expect(text).toBe('Hi 告警值班群，我是 值班机器人，随时 @ 我！')
  })
})

describe('prompt generation helpers', () => {
  it('composes role generation prompts for bot and group append modes', () => {
    const botPrompt = buildPromptGenerationMessages({
      kind: 'role',
      description: '帮团队做代码评审，说话直接，重点看安全与并发',
      context: { botName: '代码助手', roleMode: 'bot' },
    })
    expect(botPrompt.system).toContain('角色设定')
    expect(botPrompt.system).toContain('禁止调用任何工具')
    expect(botPrompt.user).toContain('代码助手')

    const appendPrompt = buildPromptGenerationMessages({
      kind: 'role',
      description: '本群聚焦前端性能分析',
      context: {
        roleMode: 'append',
        chatName: '前端优化群',
        baseRoleName: '全栈搭档',
        baseRolePrompt: '你是团队全栈搭档。',
      },
    })
    expect(appendPrompt.system).toContain('群聊追加角色设定')
    expect(appendPrompt.user).toContain('前端优化群')
    expect(appendPrompt.user).toContain('全栈搭档')
  })

  it('parses structured JSON and fenced JSON for role generation', () => {
    const parsed = parseGeneratedRoleOutput(
      '好的，结果如下：\n```json\n{"name":"安全评审专家","systemPrompt":"你是安全评审专家。\\n1. 重点核查鉴权。"}\n```',
    )
    expect(parsed.name).toBe('安全评审专家')
    expect(parsed.systemPrompt).toContain('重点核查鉴权')

    const fallback = parseGeneratedRoleOutput('你是专注前端体验的助手，回复简洁直接。')
    expect(fallback.name).toBe('')
    expect(fallback.systemPrompt).toBe('你是专注前端体验的助手，回复简洁直接。')

    expect(() => parseGeneratedRoleOutput('   ')).toThrow('有效')
  })

  it('parses structured JSON and filters invalid enum values for listener generation', () => {
    const parsed = parseGeneratedListenerOutput(
      JSON.stringify({
        name: '构建告警监听',
        prompt: '仅监听 CI 构建失败与线上告警；非告警输出 `<no_reply/>`。',
        scope: 'top_level',
        mentionFilter: 'exclude_peer',
        replyMode: 'new-topic',
        sessionMode: 'thread',
        autoCloseAfterCompletion: false,
        msgTypes: ['interactive', 'text', 'invalid_type'],
        senderTypes: ['bot', 'user', 'unknown'],
        includeKeywords: ['告警', '失败', '告警'],
        excludeKeywords: ['已恢复'],
      }),
    )

    expect(parsed.name).toBe('构建告警监听')
    expect(parsed.prompt).toContain('<no_reply/>')
    expect(parsed.scope).toBe('top_level')
    expect(parsed.mentionFilter).toBe('exclude_peer')
    expect(parsed.replyMode).toBe('new-topic')
    expect(parsed.sessionMode).toBe('thread')
    expect(parsed.autoCloseAfterCompletion).toBe(false)
    expect(parsed.msgTypes).toEqual(['interactive', 'text'])
    expect(parsed.senderTypes).toEqual(['bot', 'user'])
    expect(parsed.includeKeywords).toEqual(['告警', '失败'])
    expect(parsed.excludeKeywords).toEqual(['已恢复'])
  })
})
