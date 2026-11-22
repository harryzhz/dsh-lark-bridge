import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []

function makeStore(): LarkBridgeStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lark-store-test-'))
  tempDirs.push(dir)
  return new LarkBridgeStore(dir)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('LarkBridgeStore bot profile & group mentionTriggerMode persistence', () => {
  it('syncs bot avatarUrl and description while honoring preserveNonEmptyDescription when requested', () => {
    const store = makeStore()
    store.upsertBot({
      id: 'bot-1',
      name: 'BotOne',
      larkAppId: 'cli_1',
      larkAppSecret: 'sec_1',
      defaultWorkingDir: '~',
      description: '',
    })

    // Empty description is populated even when preserveNonEmptyDescription=true
    store.updateBotProfile(
      'bot-1',
      { avatarUrl: 'https://cdn.example.com/a1.png', description: '远程应用描述' },
      { preserveNonEmptyDescription: true },
    )
    expect(store.getBot('bot-1')?.avatarUrl).toBe('https://cdn.example.com/a1.png')
    expect(store.getBot('bot-1')?.description).toBe('远程应用描述')

    // Local manual description is preserved when preserveNonEmptyDescription=true
    store.upsertBot({
      ...store.getBot('bot-1')!,
      description: '手动本地签名',
    })
    store.updateBotProfile(
      'bot-1',
      { description: '旧的远程描述' },
      { preserveNonEmptyDescription: true },
    )
    expect(store.getBot('bot-1')?.description).toBe('手动本地签名')

    // Explicit sync overwrites with latest remote description
    store.updateBotProfile('bot-1', { description: '最新飞书应用描述' })
    expect(store.getBot('bot-1')?.description).toBe('最新飞书应用描述')
  })

  it('persists group mentionTriggerMode overrides and defaults legacy groups to inherit', () => {
    const store = makeStore()
    store.upsertBot({
      id: 'bot-1',
      name: 'BotOne',
      larkAppId: 'cli_1',
      larkAppSecret: 'sec_1',
      defaultWorkingDir: '~',
    })

    const saved = store.upsertGroup({
      botId: 'bot-1',
      chatId: 'oc_group_1',
      chatName: '超长名称研发协作与线上告警联合值班群',
      mentionTriggerMode: 'mention_only',
    })
    expect(saved.mentionTriggerMode).toBe('mention_only')
    expect(store.getGroup('bot-1', 'oc_group_1')?.mentionTriggerMode).toBe('mention_only')
  })
})
