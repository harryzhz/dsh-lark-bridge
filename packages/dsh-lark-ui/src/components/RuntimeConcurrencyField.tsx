import type { RuntimeConcurrencyConfig } from '../types.js'
import { NestedSettings, NumberField, SelectMenu, SettingRow } from './fields.js'

export function buildConcurrencyPoolKey(runtimeId: string, profileId?: string): string {
  const cleanRuntime = runtimeId.trim().toLowerCase() || 'default'
  const cleanProfile = profileId?.trim().toLowerCase()
  return cleanProfile ? `${cleanRuntime}::${cleanProfile}` : cleanRuntime
}

export function resolveRuntimeConcurrencyState(
  concurrency: RuntimeConcurrencyConfig | undefined,
  runtimeId: string,
  profileId?: string,
): {
  readonly poolKey: string
  readonly isProfile: boolean
  readonly customLimit: number | null
  readonly inheritedLimit: number
  readonly maxLimit: number
} {
  const defaultLimit = concurrency?.defaultLimit ?? 3
  const maxLimit = concurrency?.maxLimit ?? 32
  const limits = concurrency?.limits ?? {}
  const cleanProfile = profileId?.trim() ?? ''
  const isProfile = Boolean(cleanProfile)
  const baseKey = buildConcurrencyPoolKey(runtimeId)
  const poolKey = buildConcurrencyPoolKey(runtimeId, cleanProfile || undefined)
  const inheritedLimit = isProfile ? (limits[baseKey] ?? defaultLimit) : defaultLimit
  const customLimit = Object.prototype.hasOwnProperty.call(limits, poolKey) ? limits[poolKey]! : null
  return { poolKey, isProfile, customLimit, inheritedLimit, maxLimit }
}

function formatConcurrencyLabel(limit: number): string {
  return limit === 0 ? '不限制' : `${limit} 并发`
}

/**
 * Shared concurrency limit setting row (`默认 / 跟随运行时` | `自定义上限` | `不限制`)
 * backed by a single runtime/profile pool limit in SQLite.
 */
export function RuntimeConcurrencyField({
  runtimeName,
  profileName,
  isProfile,
  inheritedLimit,
  maxLimit,
  value,
  disabled,
  onChange,
}: {
  runtimeName: string
  profileName?: string
  isProfile: boolean
  inheritedLimit: number
  maxLimit: number
  /** `null` = inherit/default, `0` = unlimited, `1..maxLimit` = custom cap. */
  value: number | null
  disabled?: boolean
  onChange: (next: number | null) => void
}) {
  const mode: 'default' | 'custom' | 'unlimited' =
    value === null ? 'default' : value === 0 ? 'unlimited' : 'custom'
  const defaultLabel = isProfile
    ? `跟随运行时（${formatConcurrencyLabel(inheritedLimit)}）`
    : `默认（${formatConcurrencyLabel(inheritedLimit)}）`
  const scopeLabel = isProfile && profileName ? `${runtimeName} · ${profileName}` : runtimeName
  const fallbackCustom = inheritedLimit > 0 ? Math.min(maxLimit, inheritedLimit) : 3

  return (
    <>
      <SettingRow
        title="并发上限"
        desc={`所有使用「${scopeLabel}」的对话共享此上限，保存后即时生效`}
      >
        <SelectMenu
          value={mode}
          disabled={disabled}
          options={[
            { value: 'default', label: defaultLabel },
            { value: 'custom', label: '自定义上限' },
            { value: 'unlimited', label: '不限制' },
          ]}
          onChange={(next) => {
            if (next === 'default') onChange(null)
            else if (next === 'unlimited') onChange(0)
            else onChange(fallbackCustom)
          }}
        />
      </SettingRow>
      {mode === 'custom' && (
        <NestedSettings>
          <SettingRow title="最大并发数">
            <NumberField
              value={value && value > 0 ? value : fallbackCustom}
              min={1}
              max={maxLimit}
              disabled={disabled}
              suffix="个"
              onChange={(next) => onChange(Math.min(maxLimit, Math.max(1, Math.round(next))))}
            />
          </SettingRow>
        </NestedSettings>
      )}
    </>
  )
}
