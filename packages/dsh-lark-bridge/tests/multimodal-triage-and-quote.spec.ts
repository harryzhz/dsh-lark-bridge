import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InboundLarkMessage, LarkBotTransport } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

function makeTempDir(prefix = 'dsh-lark-mm-triage-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTriageChunks(args: Record<string, unknown>): StreamChunk[] {
  return [
    {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: 'tc_1' as never,
        name: 'route_message',
        arguments: JSON.stringify(args),
      },
    } as unknown as StreamChunk,
    { type: 'finish', reason: { kind: 'stop' } } as unknown as StreamChunk,
  ]
}

function createMultimodalMockCtx(options: {
  readonly inputModalities?: readonly ('text' | 'image')[]
  readonly triageDecision: (req: {
    readonly messages: ReadonlyArray<{ readonly content: readonly ContentBlock[] }>
  }) => Record<string, unknown>
}) {
  const listeners = new Set<(session: Session, event: SessionEvent) => void>()
  const llmRequests: Array<{ readonly messages: ReadonlyArray<{ readonly content: readonly ContentBlock[] }> }> = []
  const workerContentBlocks: Array<readonly ContentBlock[]> = []
  const savedAttachments: Array<{ readonly mediaType: string; readonly name?: string; readonly bytes: number }> = []
  const persistedTriageUserContents: Array<readonly ContentBlock[]> = []

  const emit = (session: Session, event: SessionEvent) => {
    for (const fn of [...listeners]) fn(session, event)
  }

  let attSeq = 0
  let turnSeq = 0

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    get: (key: string) => {
      if (key === 'workspaceRegistry') {
        return {
          list: () => [],
          create: async (_cwd: string, title?: string) => ({
            id: 'ws-mm',
            title: title ?? 'demo',
            cwd: '/tmp',
            sessionIds: [],
            attachSession: vi.fn().mockResolvedValue(undefined),
            setTitle: vi.fn().mockResolvedValue(undefined),
          }),
          archivedSessionIds: [],
          archiveSession: async () => true,
        }
      }
      if (key === 'attachments') {
        return {
          saveImage: vi.fn(
            async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
              savedAttachments.push({
                mediaType: input.mediaType,
                ...(input.name ? { name: input.name } : {}),
                bytes: input.data.byteLength,
              })
              return {
                attachmentId: `sha256:att_${++attSeq}`,
                mediaType: input.mediaType,
                bytes: input.data.byteLength,
                width: 640,
                height: 480,
                ...(input.name ? { name: input.name } : {}),
              }
            },
          ),
        }
      }
      if (key === 'sessionPersistence') {
        return {
          create: async () => ({
            append: async (events: readonly SessionEvent[]) => {
              for (const ev of events) {
                if (ev.type === 'user/message') {
                  const data = ev.data as { content?: readonly ContentBlock[] }
                  if (data.content) persistedTriageUserContents.push(data.content)
                }
              }
            },
            flush: async () => {},
            close: async () => {},
          }),
        }
      }
      return undefined
    },
    inject: vi.fn(),
    effect: () => () => {},
    on: (name: string, fn: (session: Session, event: SessionEvent) => void) => {
      if (name === 'session/event') listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    llm: {
      listProviders: () => [{ id: 'mock-native', name: 'Mock Native' }],
      listModels: async () => [{ id: 'mock-vision', name: 'Mock Vision' }],
      resolveModelInfo: async () => ({
        provider: 'mock-native',
        id: 'mock-vision',
        name: 'Mock Vision',
        ...(options.inputModalities ? { inputModalities: options.inputModalities } : {}),
      }),
      stream: (req: { messages: ReadonlyArray<{ content: readonly ContentBlock[] }> }) => {
        llmRequests.push(req)
        const chunks = makeTriageChunks(options.triageDecision(req))
        return {
          async *[Symbol.asyncIterator]() {
            for (const c of chunks) yield c
          },
        }
      },
    },
    sessions: { get: () => undefined },
    agents: {
      listPresets: () => [{ id: 'standard', name: 'Standard', defaultModel: 'mock-vision' }],
      get: () => undefined,
      create: async (opts: { sessionId: string; meta: { cwd: string; agentPreset: string } }) => {
        const session = {
          id: opts.sessionId,
          header: { cwd: opts.meta.cwd, agentPreset: opts.meta.agentPreset },
          snapshotEvents: () => [],
        } as unknown as Session
        const agent = {
          session,
          cancel: vi.fn(),
          followup: (userMsg: { id?: string; content: readonly ContentBlock[] }) => {
            const turn = ++turnSeq
            workerContentBlocks.push(userMsg.content)
            queueMicrotask(() => {
              emit(session, { type: 'turn/start', data: { turn } } as unknown as SessionEvent)
              emit(session, {
                type: 'user/message',
                data: { id: userMsg.id, turn },
              } as unknown as SessionEvent)
              emit(session, {
                type: 'assistant/message',
                data: {
                  turn,
                  message: { role: 'assistant', content: [{ type: 'text', text: '主运行时已处理' }] },
                },
              } as unknown as SessionEvent)
              emit(session, {
                type: 'turn/end',
                data: { turn, reason: { kind: 'completed' } },
              } as unknown as SessionEvent)
            })
          },
        }
        return { agent, dispose: async () => {} }
      },
    },
  } as unknown as Context

  return { ctx, llmRequests, workerContentBlocks, savedAttachments, persistedTriageUserContents }
}

function makeMsg(overrides: Partial<InboundLarkMessage> = {}): InboundLarkMessage {
  return {
    botId: 'bot-mm',
    larkAppId: 'cli_mm_1',
    botOpenId: 'ou_bot_mm',
    messageId: 'om_msg_1',
    chatId: 'oc_mm_chat',
    chatType: 'group',
    msgType: 'image',
    senderOpenId: 'ou_user_1',
    senderType: 'user',
    text: '',
    rawContent: '{"image_key":"img_1"}',
    mentions: [],
    imageKeys: ['img_1'],
    createTimeMs: Date.now(),
    ...overrides,
  }
}

describe('Multimodal triage, DSH ImageAttachmentRef admission & quoted message auto-prefetch', () => {
  it('filters meme images via vision-capable triage and reuses cached DSH ImageAttachmentRef on handoff without double download', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    let mode: 'silent' | 'handoff' = 'silent'
    const runtime = createMultimodalMockCtx({
      inputModalities: ['text', 'image'],
      triageDecision: () =>
        mode === 'silent'
          ? { action: 'silent', reason: '群内表情包闲聊，静默跳过' }
          : { action: 'handoff', reason: '生产接口报错截图，转交主运行时' },
    })
    const manager = new LarkBridgeManager(
      runtime.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    store.upsertBot({
      id: 'bot-mm',
      name: 'VisionBot',
      larkAppId: 'cli_mm_1',
      larkAppSecret: 'mock-secret',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      receivedReactionEmoji: 'NONE',
      router: {
        enabled: true,
        provider: 'mock-native',
        model: 'mock-vision',
        scope: 'passive_only',
        maxTriageImages: 5,
      },
    })
    store.upsertGroup({
      botId: 'bot-mm',
      chatId: 'oc_mm_chat',
      chatName: '多模态群',
      enabled: true,
      listener: {
        enabled: true,
        name: '监听所有消息',
        prompt: '排查问题时介入，表情包静默',
        msgTypes: ['text', 'post', 'interactive', 'image'],
      },
    })

    const downloadResourceBuffer = vi.fn().mockResolvedValue(JPEG_BYTES)
    const sendReply = vi.fn().mockResolvedValue({ messageId: 'om_reply_1' })
    const transport = {
      state: { botOpenId: 'ou_bot_mm', connected: true },
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply,
      downloadResourceBuffer,
    } as unknown as LarkBotTransport

    // 1. Meme image -> vision triage sees ImageBlock and returns silent -> main runtime NOT invoked
    mode = 'silent'
    await manager.inbound.handleInbound('bot-mm', transport, makeMsg({ messageId: 'om_meme_1', imageKeys: ['img_meme'] }))

    expect(runtime.llmRequests).toHaveLength(1)
    const firstTriageBlocks = runtime.llmRequests[0]!.messages[0]!.content
    expect(firstTriageBlocks).toHaveLength(2)
    expect(firstTriageBlocks[1]).toMatchObject({
      type: 'image',
      attachment: { attachmentId: 'sha256:att_1', mediaType: 'image/jpeg' },
    })
    expect(runtime.persistedTriageUserContents[0]).toHaveLength(2)
    expect(runtime.workerContentBlocks).toHaveLength(0)
    expect(sendReply).not.toHaveBeenCalled()

    // 2. Error screenshot -> vision triage returns handoff -> main runtime reuses cached ImageAttachmentRef (1 download total!)
    mode = 'handoff'
    downloadResourceBuffer.mockClear()
    await manager.inbound.handleInbound('bot-mm', transport, makeMsg({ messageId: 'om_err_1', imageKeys: ['img_err'] }))

    expect(downloadResourceBuffer).toHaveBeenCalledTimes(1)
    expect(runtime.savedAttachments).toHaveLength(2)
    expect(runtime.savedAttachments[1]).toMatchObject({ mediaType: 'image/jpeg', name: 'img_err.jpg' })
    expect(runtime.workerContentBlocks).toHaveLength(1)
    expect(runtime.workerContentBlocks[0]!.filter((b) => b.type === 'image')).toEqual([
      expect.objectContaining({
        type: 'image',
        attachment: expect.objectContaining({ attachmentId: 'sha256:att_2', mediaType: 'image/jpeg' }),
      }),
    ])
    expect(sendReply).toHaveBeenCalledTimes(1)

    await manager.stop()
    store.close()
  })

  it('auto-bypasses image messages when the triage model is text-only without downloading images during triage', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createMultimodalMockCtx({
      inputModalities: ['text'],
      triageDecision: () => ({ action: 'silent', reason: 'should not be called' }),
    })
    const manager = new LarkBridgeManager(
      runtime.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    store.upsertBot({
      id: 'bot-mm',
      name: 'TextOnlyTriageBot',
      larkAppId: 'cli_mm_1',
      larkAppSecret: 'mock-secret',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      receivedReactionEmoji: 'NONE',
      router: {
        enabled: true,
        provider: 'mock-native',
        model: 'mock-vision',
        scope: 'passive_only',
        maxTriageImages: 5,
      },
    })
    store.upsertGroup({
      botId: 'bot-mm',
      chatId: 'oc_mm_chat',
      enabled: true,
      listener: {
        enabled: true,
        name: '监听',
        prompt: '必要时回复',
        msgTypes: ['text', 'post', 'interactive', 'image'],
      },
    })

    const downloadResourceBuffer = vi.fn().mockResolvedValue(PNG_BYTES)
    const sendReply = vi.fn().mockResolvedValue({ messageId: 'om_reply_2' })
    const transport = {
      state: { botOpenId: 'ou_bot_mm', connected: true },
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply,
      downloadResourceBuffer,
    } as unknown as LarkBotTransport

    await manager.inbound.handleInbound('bot-mm', transport, makeMsg({ messageId: 'om_img_textonly', imageKeys: ['img_only'] }))

    // Text-only triage model must NOT be called; main runtime receives the image with 1 download
    expect(runtime.llmRequests).toHaveLength(0)
    expect(downloadResourceBuffer).toHaveBeenCalledTimes(1)
    expect(runtime.workerContentBlocks).toHaveLength(1)
    expect(runtime.workerContentBlocks[0]!.filter((b) => b.type === 'image')).toHaveLength(1)
    expect(sendReply).toHaveBeenCalledTimes(1)

    await manager.stop()
    store.close()
  })

  it('auto-prefetches quoted text and quoted images for both triage and main runtime while skipping Feishu card fallback placeholders', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createMultimodalMockCtx({
      inputModalities: ['text', 'image'],
      triageDecision: () => ({ action: 'handoff', reason: '引用报错图文需主运行时排查' }),
    })
    const manager = new LarkBridgeManager(
      runtime.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    store.upsertBot({
      id: 'bot-mm',
      name: 'QuoteBot',
      larkAppId: 'cli_mm_1',
      larkAppSecret: 'mock-secret',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      receivedReactionEmoji: 'NONE',
      router: {
        enabled: true,
        provider: 'mock-native',
        model: 'mock-vision',
        scope: 'all_group',
        maxTriageImages: 5,
      },
    })
    store.upsertGroup({
      botId: 'bot-mm',
      chatId: 'oc_mm_chat',
      enabled: true,
    })

    const getMessageDetail = vi.fn(async (id: string) => {
      if (id === 'om_quoted_post') {
        return {
          messageId: 'om_quoted_post',
          msgType: 'post',
          senderName: 'Alex',
          senderType: 'user' as const,
          text: '网关返回 502 错误',
          createTimeMs: Date.now() - 5000,
          resources: [{ type: 'image' as const, key: 'img_quoted_1' }],
        }
      }
      if (id === 'om_quoted_card_fallback') {
        return {
          messageId: 'om_quoted_card_fallback',
          msgType: 'interactive',
          senderType: 'bot' as const,
          text: '请升级至最新版本客户端，以查看内容',
          createTimeMs: Date.now() - 5000,
          resources: [{ type: 'image' as const, key: 'img_placeholder_icon' }],
        }
      }
      return undefined
    })
    const downloadResourceBuffer = vi.fn().mockResolvedValue(PNG_BYTES)
    const sendReply = vi.fn().mockResolvedValue({ messageId: 'om_reply_q' })
    const transport = {
      state: { botOpenId: 'ou_bot_mm', connected: true },
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply,
      getMessageDetail,
      downloadResourceBuffer,
    } as unknown as LarkBotTransport

    // 1. Quoting a post with text + image prefetches both for triage and main runtime (single download!)
    await manager.inbound.handleInbound(
      'bot-mm',
      transport,
      makeMsg({
        messageId: 'om_reply_to_post',
        parentId: 'om_quoted_post',
        msgType: 'text',
        text: '@_user_1 帮我看下这个报错',
        mentions: [{ key: '@_user_1', openId: 'ou_bot_mm', name: 'QuoteBot' }],
        imageKeys: [],
      }),
    )

    expect(getMessageDetail).toHaveBeenCalledWith('om_quoted_post', {
      downloadResources: false,
      includeRaw: false,
    })
    expect(downloadResourceBuffer).toHaveBeenCalledTimes(1)
    expect(downloadResourceBuffer).toHaveBeenCalledWith('om_quoted_post', 'img_quoted_1', 'image')

    // Triage received both quoted text and quoted image block
    const triageContent = runtime.llmRequests[0]!.messages[0]!.content
    const triageText = (triageContent[0] as { text: string }).text
    expect(triageText).toContain('<quoted_message message_id="om_quoted_post"')
    expect(triageText).toContain('网关返回 502 错误')
    expect(triageContent.filter((b) => b.type === 'image')).toHaveLength(1)

    // Main runtime received prefetched quoted text & reused cached image block
    const workerContent = runtime.workerContentBlocks[0]!
    const workerText = (workerContent[0] as { text: string }).text
    expect(workerText).toContain('<quoted_message message_id="om_quoted_post"')
    expect(workerText).toContain('网关返回 502 错误')
    expect(workerText).toContain('已自动附带 1 张引用图片')
    expect(workerContent.filter((b) => b.type === 'image')).toHaveLength(1)

    // 2. Quoting a Feishu Schema 2.0 card fallback must NOT download its placeholder icon
    downloadResourceBuffer.mockClear()
    await manager.inbound.handleInbound(
      'bot-mm',
      transport,
      makeMsg({
        messageId: 'om_reply_to_card',
        parentId: 'om_quoted_card_fallback',
        msgType: 'text',
        text: '@_user_1 接着讲下这点',
        mentions: [{ key: '@_user_1', openId: 'ou_bot_mm', name: 'QuoteBot' }],
        imageKeys: [],
      }),
    )
    expect(downloadResourceBuffer).not.toHaveBeenCalled()
    const workerText2 = (runtime.workerContentBlocks[1]![0] as { text: string }).text
    expect(workerText2).not.toContain('请升级至最新版本客户端')
    expect(workerText2).toContain('引用消息：om_quoted_card_fallback')

    await manager.stop()
    store.close()
  })
})
