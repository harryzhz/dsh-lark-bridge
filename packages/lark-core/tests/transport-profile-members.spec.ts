import * as lark from '@larksuiteoapi/node-sdk'
import { describe, expect, it, vi } from 'vitest'
import { LarkBotConfigSchema, LarkBotTransport, type LarkBotProfile } from '../src/index.js'

function createBot() {
  return LarkBotConfigSchema.parse({
    id: 'bot-alpha',
    name: 'AlphaBot',
    larkAppId: 'cli_alpha_001',
    larkAppSecret: 'sec_alpha_001',
    defaultWorkingDir: '~',
  })
}

describe('LarkBotTransport profile description sync & member/bot avatar resolution', () => {
  it('fetches both bot/v3/info and application/v6/applications/:app_id to sync avatar and description', async () => {
    const observedProfiles: LarkBotProfile[] = []
    const transport = new LarkBotTransport(createBot(), {
      onMessage: () => {},
      onBotProfile: (profile) => observedProfiles.push(profile),
    })

    const client = (transport as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client
    client.request = vi.fn(async (req: { url: string }) => {
      if (req.url === '/open-apis/bot/v3/info/') {
        return {
          bot: {
            open_id: 'ou_bot_self',
            app_name: 'AlphaBot',
            avatar_url: 'https://cdn.example.com/bot-alpha.png',
          },
        }
      }
      if (req.url.startsWith('/open-apis/application/v6/applications/')) {
        return {
          data: {
            app: {
              app_name: 'AlphaBot',
              description: 'Fallback description',
              i18n: [
                {
                  i18n_key: 'zh_cn',
                  name: 'AlphaBot',
                  description: '24 小时在线研发协作分身',
                },
              ],
            },
          },
        }
      }
      return {}
    })

    const profile = await transport.fetchBotProfile()
    expect(profile).toEqual({
      openId: 'ou_bot_self',
      name: 'AlphaBot',
      avatarUrl: 'https://cdn.example.com/bot-alpha.png',
      description: '24 小时在线研发协作分身',
    })
    expect(observedProfiles).toHaveLength(1)
    expect(transport.state.description).toBe('24 小时在线研发协作分身')
  })

  it('classifies is_agent=true as bot, enriches 41050 human avatars via directory lookup, and resolves peer bot avatars', async () => {
    const transport = new LarkBotTransport(createBot(), { onMessage: () => {} })
    const internalClient = (
      transport as unknown as {
        client: {
          request: ReturnType<typeof vi.fn>
          im: { chatMembers: { get: ReturnType<typeof vi.fn> } }
          contact: { user: { get: ReturnType<typeof vi.fn> } }
        }
      }
    ).client

    internalClient.request = vi.fn(async (req: { url: string }) => {
      if (req.url === '/open-apis/bot/v3/info/') {
        return { bot: { open_id: 'ou_bot_self', app_name: 'AlphaBot' } }
      }
      if (req.url.endsWith('/members/list')) {
        return {
          data: {
            bots: [
              { app_id: 'cli_alpha_001', member_id: 'ou_bot_self', name: 'AlphaBot' },
              { app_id: 'cli_peer_002', member_id: 'ou_peer_bot', name: 'PeerBot' },
            ],
            has_more: false,
          },
        }
      }
      if (req.url.endsWith('/members/bots')) {
        return {
          data: {
            items: [
              { bot_id: 'ou_bot_self', bot_name: 'AlphaBot' },
              { bot_id: 'ou_peer_bot', bot_name: 'PeerBot' },
            ],
            has_more: false,
          },
        }
      }
      return {}
    })

    internalClient.im.chatMembers.get = vi.fn(async ({ params }: { params: { member_id_type: string } }) => {
      if (params.member_id_type === 'user_id') {
        return {
          data: {
            items: [
              { member_id: 'emp_owner', name: 'Owner', is_agent: false },
              { member_id: 'emp_colleague', name: 'Colleague', is_agent: false },
              { member_id: 'emp_agent', name: 'AgentClone', is_agent: true },
            ],
            has_more: false,
          },
        }
      }
      return {
        data: {
          items: [
            { member_id: 'ou_owner', name: 'Owner', is_agent: false },
            { member_id: 'ou_colleague', name: 'Colleague', is_agent: false },
            { member_id: 'ou_agent_clone', name: 'AgentClone', is_agent: true },
          ],
          has_more: false,
        },
      }
    })

    internalClient.contact.user.get = vi.fn(async ({ path }: { path: { user_id: string } }) => {
      if (path.user_id === 'ou_owner') {
        return {
          data: {
            user: {
              name: 'Owner',
              avatar: { avatar_72: 'https://cdn.example.com/owner.png' },
            },
          },
        }
      }
      const err = new Error('41050 no user authority error')
      throw err
    })

    const members = await transport.listChatMembersAndBots('oc_demo', {
      userDirectoryLookup: async (queries) => {
        expect(queries).toEqual(['Colleague'])
        return [
          {
            openId: 'ou_other_app_scoped_id',
            userId: 'emp_colleague',
            name: 'Colleague',
            avatarUrl: 'https://cdn.example.com/colleague.png',
          },
        ]
      },
      resolveBotAvatar: async (bot) => {
        if (bot.larkAppId === 'cli_peer_002') {
          return 'https://cdn.example.com/peer-bot.png'
        }
        return undefined
      },
    })

    expect(members).toEqual([
      {
        openId: 'ou_colleague',
        userId: 'emp_colleague',
        name: 'Colleague',
        memberType: 'user',
        avatarUrl: 'https://cdn.example.com/colleague.png',
      },
      {
        openId: 'ou_owner',
        name: 'Owner',
        memberType: 'user',
        avatarUrl: 'https://cdn.example.com/owner.png',
      },
      {
        openId: 'ou_agent_clone',
        name: 'AgentClone',
        memberType: 'bot',
      },
      {
        openId: 'ou_peer_bot',
        larkAppId: 'cli_peer_002',
        name: 'PeerBot',
        memberType: 'bot',
        avatarUrl: 'https://cdn.example.com/peer-bot.png',
      },
    ])
  })

  it('refuses blank/invisible-only sendReply payloads, ACKs inbound events without blocking on onMessage, and prevents WSClient leaks on concurrent start/stop', async () => {
    const logs: string[] = []
    let releaseMessageHandler!: () => void
    const onMessageStarted = vi.fn()
    const onChatMembershipChange = vi.fn()

    const transport = new LarkBotTransport(createBot(), {
      onMessage: async () => {
        onMessageStarted()
        await new Promise<void>((resolve) => {
          releaseMessageHandler = resolve
        })
      },
      onChatMembershipChange,
      logger: (_level, msg) => logs.push(msg),
    })

    const internalClient = (
      transport as unknown as {
        client: {
          request: ReturnType<typeof vi.fn>
          im: {
            message: {
              create: ReturnType<typeof vi.fn>
              reply: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    ).client
    internalClient.im.message.create = vi.fn()
    internalClient.im.message.reply = vi.fn()

    // 1. Blank / zero-width replies are refused at the transport boundary without hitting Feishu API
    expect(
      await transport.sendReply({ chatId: 'oc_demo', replyMode: 'chat', text: '\u200b' }),
    ).toEqual({})
    expect(
      await transport.sendReply({
        chatId: 'oc_demo',
        replyToMessageId: 'om_1',
        replyMode: 'reply',
        text: ' \u200c\uFEFF\n ',
      }),
    ).toEqual({})
    expect(internalClient.im.message.create).not.toHaveBeenCalled()
    expect(internalClient.im.message.reply).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes('Refused to send blank reply'))).toBe(true)

    // 2. Non-blocking ACK + subscribed event handlers + concurrent start/stop WSClient leak guard
    let capturedDispatcher: lark.EventDispatcher | undefined
    const closeSpy = vi.fn()
    let releaseProfile!: () => void
    internalClient.request = vi.fn(async (req: { url: string }) => {
      if (req.url === '/open-apis/bot/v3/info/') {
        await new Promise<void>((resolve) => {
          releaseProfile = resolve
        })
        return { bot: { open_id: 'ou_bot_self', app_name: 'AlphaBot' } }
      }
      return {}
    })

    const wsStartSpy = vi
      .spyOn(lark.WSClient.prototype, 'start')
      .mockImplementation(async function (this: lark.WSClient, params: { eventDispatcher: lark.EventDispatcher }) {
        capturedDispatcher = params.eventDispatcher
      })
    const wsCloseSpy = vi
      .spyOn(lark.WSClient.prototype, 'close')
      .mockImplementation(function () {
        closeSpy()
      })

    try {
      // Concurrent start() calls share one startup and only spawn one WSClient
      const p1 = transport.start()
      const p2 = transport.start()
      await vi.waitFor(() => expect(releaseProfile).toBeTypeOf('function'))
      releaseProfile()
      await Promise.all([p1, p2])
      expect(wsStartSpy).toHaveBeenCalledTimes(1)
      expect(capturedDispatcher).toBeDefined()

      // im.message.receive_v1 resolves immediately without awaiting slow onMessage (preventing Feishu 3s ACK timeout)
      const invokeResult = capturedDispatcher!.invoke(
        {
          schema: '2.0',
          header: { event_type: 'im.message.receive_v1' },
          event: {
            sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
            message: {
              message_id: 'om_ack_fast',
              chat_id: 'oc_demo',
              chat_type: 'group',
              message_type: 'text',
              content: '{"text":"hello"}',
            },
          },
        },
        { needCheck: false },
      )
      await expect(invokeResult).resolves.toBeUndefined()
      await vi.waitFor(() => expect(onMessageStarted).toHaveBeenCalledTimes(1))
      releaseMessageHandler()

      // Common subscribed events are registered so SDK does not spam unhandled-event warnings
      await capturedDispatcher!.invoke(
        { schema: '2.0', header: { event_type: 'im.message.reaction.created_v1' }, event: {} },
        { needCheck: false },
      )
      await capturedDispatcher!.invoke(
        { schema: '2.0', header: { event_type: 'im.chat.member.bot.added_v1' }, event: {} },
        { needCheck: false },
      )
      expect(onChatMembershipChange).toHaveBeenCalledTimes(1)

      await transport.stop()
      expect(closeSpy).toHaveBeenCalledTimes(1)

      // Calling stop() mid-start (during fetchBotProfile) aborts startup without creating a zombie WSClient
      wsStartSpy.mockClear()
      let releaseAbortedProfile!: () => void
      internalClient.request = vi.fn(async (req: { url: string }) => {
        if (req.url === '/open-apis/bot/v3/info/') {
          await new Promise<void>((resolve) => {
            releaseAbortedProfile = resolve
          })
        }
        return {}
      })
      const startAborted = transport.start()
      await vi.waitFor(() => expect(releaseAbortedProfile).toBeTypeOf('function'))
      await transport.stop()
      releaseAbortedProfile()
      await startAborted
      expect(wsStartSpy).not.toHaveBeenCalled()
    } finally {
      wsStartSpy.mockRestore()
      wsCloseSpy.mockRestore()
    }
  })

  it('caps listMessages page_size to <= 50 and paginates via page_token when filtering non-thread om_* roots or fetching > 50 items', async () => {
    const transport = new LarkBotTransport(createBot(), { onMessage: () => {} })
    const internalClient = (
      transport as unknown as {
        client: {
          im: {
            message: {
              get: ReturnType<typeof vi.fn>
              list: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    ).client

    // Non-thread message (no thread_id) -> falls back to chat list filtering by filterRootMessageId
    internalClient.im.message.get = vi.fn().mockResolvedValue({
      data: { items: [{ message_id: 'om_root_1' }] },
    })

    const observedPageSizes: number[] = []
    internalClient.im.message.list = vi.fn(
      async ({ params }: { params: { page_size: number; page_token?: string } }) => {
        observedPageSizes.push(params.page_size)
        expect(params.page_size).toBeLessThanOrEqual(50)
        if (!params.page_token) {
          return {
            data: {
              has_more: true,
              page_token: 'tok_page_2',
              items: [
                {
                  message_id: 'om_unrelated',
                  chat_id: 'oc_demo',
                  msg_type: 'text',
                  body: { content: '{"text":"unrelated"}' },
                  sender: { id: 'ou_other', sender_type: 'user' },
                  create_time: '2000',
                },
                {
                  message_id: 'om_reply_1',
                  root_id: 'om_root_1',
                  chat_id: 'oc_demo',
                  msg_type: 'text',
                  body: { content: '{"text":"second reply"}' },
                  sender: { id: 'ou_user_1', sender_type: 'user' },
                  create_time: '1900',
                },
              ],
            },
          }
        }
        return {
          data: {
            has_more: false,
            items: [
              {
                message_id: 'om_root_1',
                chat_id: 'oc_demo',
                msg_type: 'text',
                body: { content: '{"text":"initial root"}' },
                sender: { id: 'ou_user_1', sender_type: 'user' },
                create_time: '1000',
              },
            ],
          },
        }
      },
    )

    const threadMsgs = await transport.listMessages({
      chatId: 'oc_demo',
      threadId: 'om_root_1',
      limit: 30,
    })
    expect(observedPageSizes).toEqual([50, 50])
    expect(threadMsgs.map((m) => m.messageId)).toEqual(['om_root_1', 'om_reply_1'])

    // Unfiltered request with limit=75 must split into 50 + 25 pages
    observedPageSizes.length = 0
    internalClient.im.message.list = vi.fn(
      async ({ params }: { params: { page_size: number; page_token?: string } }) => {
        observedPageSizes.push(params.page_size)
        expect(params.page_size).toBeLessThanOrEqual(50)
        if (!params.page_token) {
          return {
            data: {
              has_more: true,
              page_token: 'tok_2',
              items: Array.from({ length: 50 }, (_, idx) => ({
                message_id: `om_p1_${idx}`,
                chat_id: 'oc_demo',
                msg_type: 'text',
                body: { content: `{"text":"msg ${idx}"}` },
                sender: { id: 'ou_user_1', sender_type: 'user' },
                create_time: String(3000 - idx),
              })),
            },
          }
        }
        return {
          data: {
            has_more: false,
            items: Array.from({ length: 25 }, (_, idx) => ({
              message_id: `om_p2_${idx}`,
              chat_id: 'oc_demo',
              msg_type: 'text',
              body: { content: `{"text":"older ${idx}"}` },
              sender: { id: 'ou_user_1', sender_type: 'user' },
              create_time: String(2000 - idx),
            })),
          },
        }
      },
    )

    const chatMsgs = await transport.listMessages({ chatId: 'oc_demo', limit: 75 })
    expect(observedPageSizes).toEqual([50, 25])
    expect(chatMsgs).toHaveLength(75)
  })
})
