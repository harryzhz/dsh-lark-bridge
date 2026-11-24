import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  detectImageMediaType,
  extensionForImageMediaType,
  type LarkBotTransport,
  type SupportedImageMediaType,
} from '@dsh-lark/lark-core'

const QUOTE_PREFETCH_TIMEOUT_MS = 2_000
const IMAGE_DOWNLOAD_TIMEOUT_MS = 3_000
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const FEISHU_CARD_FALLBACK_TEXT = '请升级至最新版本客户端，以查看内容'

interface HostAttachmentStore {
  saveImage?(input: {
    data: Uint8Array
    mediaType: SupportedImageMediaType
    name?: string
  }): Promise<unknown>
}

export interface PrefetchedQuotedMessage {
  readonly messageId: string
  readonly msgType: string
  readonly senderName?: string
  readonly senderType?: 'user' | 'bot'
  readonly text?: string
  readonly imageKeys: readonly string[]
  readonly hasNonImageResources: boolean
}

export interface ImageRefTarget {
  readonly messageId: string
  readonly imageKey: string
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (signal?.aborted) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
        timer.unref?.()
        if (signal) {
          onAbort = () => resolve(undefined)
          signal.addEventListener('abort', onAbort, { once: true })
        }
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function downloadImageBytes(
  transport: LarkBotTransport,
  messageId: string,
  imageKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (typeof transport.downloadResourceBuffer === 'function') {
    const buf = await withTimeout(
      transport.downloadResourceBuffer(messageId, imageKey, 'image'),
      timeoutMs,
      signal,
    )
    if (buf && buf.byteLength > 0) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    return undefined
  }
  if (typeof transport.downloadImageAsBase64 === 'function') {
    const b64 = await withTimeout(
      transport.downloadImageAsBase64(messageId, imageKey),
      timeoutMs,
      signal,
    )
    if (b64) {
      const buf = Buffer.from(b64, 'base64')
      if (buf.byteLength > 0) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }
  }
  return undefined
}

/**
 * Per-turn cache for prefetched quoted messages and admitted DSH image blocks so
 * multimodal triage and subsequent main-runtime handoff never fetch or store the
 * same Feishu message or image twice.
 */
export class InboundMediaCache {
  private readonly quoteCache = new Map<string, PrefetchedQuotedMessage | null>()
  private readonly imageCache = new Map<string, ContentBlock | null>()

  async prefetchQuotedMessage(
    transport: LarkBotTransport,
    messageId: string,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<PrefetchedQuotedMessage | undefined> {
    const id = messageId.trim()
    if (!id) return undefined
    if (this.quoteCache.has(id)) {
      return this.quoteCache.get(id) ?? undefined
    }
    if (typeof transport.getMessageDetail !== 'function') {
      this.quoteCache.set(id, null)
      return undefined
    }
    const detail = await withTimeout(
      transport.getMessageDetail(id, { downloadResources: false, includeRaw: false }),
      options.timeoutMs ?? QUOTE_PREFETCH_TIMEOUT_MS,
      options.signal,
    )
    if (!detail) {
      this.quoteCache.set(id, null)
      return undefined
    }

    const rawText = detail.text?.trim() ?? ''
    const isCardUpgradePlaceholder =
      detail.msgType === 'interactive' && rawText === FEISHU_CARD_FALLBACK_TEXT
    const text = isCardUpgradePlaceholder ? '' : rawText

    // Feishu Schema 2.0 cards include a placeholder icon alongside the upgrade notice;
    // skip extracting images from that fallback payload so we never download Feishu's placeholder icon.
    const resources = Array.isArray(detail.resources) ? detail.resources : []
    const imageKeys = isCardUpgradePlaceholder
      ? []
      : resources
          .filter((r) => r.type === 'image' && typeof r.key === 'string' && r.key.trim().length > 0)
          .map((r) => r.key.trim())
    const hasNonImageResources = resources.some((r) => r.type !== 'image')

    // If a quoted interactive card yielded nothing beyond Feishu's upgrade fallback,
    // leave it as undefined so the caller falls back to the standard CLI hint.
    if (isCardUpgradePlaceholder && imageKeys.length === 0 && !hasNonImageResources) {
      this.quoteCache.set(id, null)
      return undefined
    }

    const prefetched: PrefetchedQuotedMessage = {
      messageId: detail.messageId || id,
      msgType: detail.msgType || 'text',
      ...(detail.senderName ? { senderName: detail.senderName } : {}),
      ...(detail.senderType ? { senderType: detail.senderType } : {}),
      ...(text ? { text } : {}),
      imageKeys,
      hasNonImageResources,
    }
    this.quoteCache.set(id, prefetched)
    return prefetched
  }

  async admitImage(
    ctx: Context,
    transport: LarkBotTransport,
    messageId: string,
    imageKey: string,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ContentBlock | undefined> {
    const cacheKey = `${messageId}:${imageKey}`
    if (this.imageCache.has(cacheKey)) {
      return this.imageCache.get(cacheKey) ?? undefined
    }

    const bytes = await downloadImageBytes(
      transport,
      messageId,
      imageKey,
      options.timeoutMs ?? IMAGE_DOWNLOAD_TIMEOUT_MS,
      options.signal,
    )
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      this.imageCache.set(cacheKey, null)
      return undefined
    }

    const detectedMediaType = detectImageMediaType(bytes)
    const attachments = ctx.get?.('attachments' as never) as HostAttachmentStore | undefined

    if (typeof attachments?.saveImage === 'function' && detectedMediaType) {
      try {
        const ref = await attachments.saveImage({
          data: bytes,
          mediaType: detectedMediaType,
          name: `${imageKey}.${extensionForImageMediaType(detectedMediaType)}`,
        })
        const block = { type: 'image', attachment: ref } as unknown as ContentBlock
        this.imageCache.set(cacheKey, block)
        return block
      } catch (err) {
        ctx.logger?.warn?.(
          `[lark-bridge] failed to save image attachment (${imageKey}): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // Graceful fallback when host `ctx.attachments` is absent (e.g. lightweight test harnesses)
    // or when bytes use a non-standard header that could not be normalized by attachment admission.
    const fallbackMediaType = detectedMediaType ?? 'image/png'
    const block = {
      type: 'image',
      mediaType: fallbackMediaType,
      data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
    } as unknown as ContentBlock
    this.imageCache.set(cacheKey, block)
    return block
  }

  async admitImages(
    ctx: Context,
    transport: LarkBotTransport,
    targets: readonly ImageRefTarget[],
    options: {
      readonly maxCount?: number
      readonly timeoutMs?: number
      readonly signal?: AbortSignal
    } = {},
  ): Promise<{ readonly blocks: readonly ContentBlock[]; readonly failedCount: number }> {
    const seen = new Set<string>()
    const unique: ImageRefTarget[] = []
    const cap = options.maxCount ?? targets.length
    for (const target of targets) {
      if (unique.length >= cap) break
      if (!target.messageId || !target.imageKey) continue
      const key = `${target.messageId}:${target.imageKey}`
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(target)
    }

    const blocks: ContentBlock[] = []
    let failedCount = 0
    for (const target of unique) {
      if (options.signal?.aborted) {
        failedCount += unique.length - blocks.length - failedCount
        break
      }
      const block = await this.admitImage(ctx, transport, target.messageId, target.imageKey, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (block) {
        blocks.push(block)
      } else {
        failedCount += 1
      }
    }
    return { blocks, failedCount }
  }
}
