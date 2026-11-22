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
})
