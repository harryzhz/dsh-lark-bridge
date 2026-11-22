import { afterEach, describe, expect, it, vi } from 'vitest'
import { bridgeApi, configureBridgeTransport, type BridgeConnectionRpcLike } from '../src/api.js'

afterEach(() => {
  configureBridgeTransport(undefined)
  vi.restoreAllMocks()
})

describe('bridgeApi Desktop & Web Connection RPC transport', () => {
  it('routes all API methods through ctx.connection.rpc without calling global fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not call fetch'))
    const calls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
    const rpc: BridgeConnectionRpcLike = {
      async call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload })
        const req = payload as { method: string; path: string; body?: unknown }
        if (req.path === '/bots' && req.method === 'GET') {
          return { ok: true, value: { ok: true, bots: [{ id: 'atlas', name: 'Atlas' }] } }
        }
        if (req.path === '/fs/dirs' && req.method === 'POST') {
          return { ok: true, value: { ok: true, path: '/tmp/new-dir' } }
        }
        return { ok: false, error: { code: 'lark-bridge/error', message: 'not_found' } }
      },
    }

    configureBridgeTransport(rpc)
    const bots = await bridgeApi.bots()
    expect(bots).toHaveLength(1)
    expect(bots[0]?.id).toBe('atlas')

    const createdPath = await bridgeApi.createDir('/tmp', 'new-dir')
    expect(createdPath).toBe('/tmp/new-dir')

    await expect(bridgeApi.deleteBot('missing')).rejects.toThrow('not_found')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(calls).toEqual([
      { channel: '/api', endpoint: 'lark-bridge-rpc', payload: { method: 'GET', path: '/bots' } },
      {
        channel: '/api',
        endpoint: 'lark-bridge-rpc',
        payload: { method: 'POST', path: '/fs/dirs', body: { parentPath: '/tmp', name: 'new-dir' } },
      },
      { channel: '/api', endpoint: 'lark-bridge-rpc', payload: { method: 'DELETE', path: '/bots/missing' } },
    ])
  })

  it('ignores stale disposer calls when a newer transport is active', async () => {
    const staleRpc: BridgeConnectionRpcLike = {
      call: vi.fn().mockResolvedValue({ ok: true, value: { ok: true, bots: [] } }),
    }
    const freshRpc: BridgeConnectionRpcLike = {
      call: vi.fn().mockResolvedValue({ ok: true, value: { ok: true, bots: [{ id: 'fresh' }] } }),
    }

    configureBridgeTransport(staleRpc)
    configureBridgeTransport(freshRpc)
    configureBridgeTransport(undefined, staleRpc)

    const bots = await bridgeApi.bots()
    expect(bots).toEqual([{ id: 'fresh' }])
    expect(freshRpc.call).toHaveBeenCalledTimes(1)
    expect(staleRpc.call).not.toHaveBeenCalled()
  })
})
