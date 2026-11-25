import { describe, expect, it } from 'vitest'
import {
  buildSparklineGeometry,
  computeNiceAxisMax,
  formatBytes,
  formatDeltaBadge,
  formatLatencyMs,
  formatTokens,
  formatUptime,
  resolveErrorCodeLabel,
  resolveHeatmapLevel,
  resolveTableLabel,
  resolveTriggerLabel,
} from '../src/views/observability-model.js'

describe('observability-model pure helpers', () => {
  it('formats tokens, bytes, latency, and uptime across scales', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(842)).toBe('842')
    expect(formatTokens(2_450)).toBe('2.45K')
    expect(formatTokens(18_400)).toBe('18.4K')
    expect(formatTokens(3_250_000)).toBe('3.25M')
    expect(formatTokens(1_450_000_000)).toBe('1.45B')

    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(12 * 1024)).toBe('12.0 KB')
    expect(formatBytes(4.5 * 1024 * 1024)).toBe('4.50 MB')
    expect(formatBytes(1.25 * 1024 ** 3)).toBe('1.25 GB')

    expect(formatLatencyMs(0)).toBe('—')
    expect(formatLatencyMs(340)).toBe('340ms')
    expect(formatLatencyMs(2_450)).toBe('2.45s')
    expect(formatLatencyMs(18_400)).toBe('18.4s')
    expect(formatLatencyMs(92_000)).toBe('1m 32s')

    expect(formatUptime(120)).toBe('2m')
    expect(formatUptime(5 * 3600 + 1800)).toBe('5h 30m')
    expect(formatUptime(3 * 86400 + 4 * 3600)).toBe('3d 4h')
  })

  it('computes delta badge tones including inverted latency semantics', () => {
    expect(formatDeltaBadge(null)).toEqual({ text: 'NEW', tone: 'neutral' })
    expect(formatDeltaBadge(0)).toEqual({ text: '0%', tone: 'neutral' })
    expect(formatDeltaBadge(14.5)).toEqual({ text: '+14.5%', tone: 'good' })
    expect(formatDeltaBadge(-8.2)).toEqual({ text: '−8.2%', tone: 'bad' })
    expect(formatDeltaBadge(-12.4, { invertGood: true })).toEqual({ text: '−12.4%', tone: 'good' })
    expect(formatDeltaBadge(9.1, { invertGood: true })).toEqual({ text: '+9.1%', tone: 'bad' })
    expect(formatDeltaBadge(1.2, { unit: 'pp' })).toEqual({ text: '+1.2pp', tone: 'good' })
  })

  it('computes sparkline geometry, heatmap levels, nice axis bounds, and labels', () => {
    const empty = buildSparklineGeometry([0, 0, 0], 84, 28)
    expect(empty.hasData).toBe(false)
    expect(empty.areaPath).toBe('')

    const active = buildSparklineGeometry([10, 40, 20, 80], 84, 28)
    expect(active.hasData).toBe(true)
    expect(active.linePath.startsWith('M 0 ')).toBe(true)
    expect(active.areaPath.endsWith('Z')).toBe(true)

    expect(resolveHeatmapLevel(0, 10)).toBe(0)
    expect(resolveHeatmapLevel(1, 10)).toBe(1)
    expect(resolveHeatmapLevel(3, 10)).toBe(2)
    expect(resolveHeatmapLevel(6, 10)).toBe(3)
    expect(resolveHeatmapLevel(9, 10)).toBe(4)

    expect(computeNiceAxisMax(0)).toBe(1)
    expect(computeNiceAxisMax(14)).toBe(20)
    expect(computeNiceAxisMax(42)).toBe(50)
    expect(computeNiceAxisMax(73)).toBe(100)

    expect(resolveTriggerLabel('triage')).toBe('智能分流')
    expect(resolveErrorCodeLabel('rate_limited')).toBe('上游限流 / 429')
    expect(resolveTableLabel('telemetry_usage_events')).toBe('遥测明细事件')
  })
})
