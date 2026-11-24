const HEX_CORE_RING_PATH =
  'M11 2.38V4.83L5.29 8.13V10.65H3.17V6.9Z M3.17 13.35H5.29V15.88L11 19.17V21.62L3.17 17.1Z M13 2.38L20.83 6.9V17.1L13 21.62V19.17L18.71 15.88V8.13L13 4.83Z'
const HEX_CORE_CENTER_PATH = 'M12 8.45L15.07 10.22V13.78L12 15.55L8.93 13.78V10.22Z'

/**
 * Monochrome Hex Terminal Core icon for the DSH sidebar menu.
 * Matches the split-hexagon + inner-core brand mark in `icon.svg`, optically
 * tuned for 16px monochrome rendering via `currentColor` across light/dark themes.
 */
export function LarkSidebarIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d={HEX_CORE_RING_PATH} fill="currentColor" />
      <path d={HEX_CORE_CENTER_PATH} fill="currentColor" />
    </svg>
  )
}

/**
 * Animated monochrome Hex Terminal Core emblem rendered before the main page title.
 * Gently flips horizontally around the Y-axis and restores, matching the monochrome DSH palette.
 */
export function LarkTitleIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span className={className ? `fb-title-icon ${className}` : 'fb-title-icon'} aria-hidden="true">
      <span className="fb-title-icon-glyph">
        <LarkSidebarIcon size={size} />
      </span>
    </span>
  )
}

/**
 * Monochrome 16x16 outline agent icon for the "智能体" tab.
 * Features rounded visor head, top antenna node, side ears, and friendly eyes
 * using the exact stroke weight (`1.15`) as sibling DSH outline icons.
 */
export function RobotTabIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.15}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden="true"
    >
      <line x1="8" y1="2.2" x2="8" y2="4.2" />
      <circle cx="8" cy="1.7" r="0.65" fill="currentColor" stroke="none" />
      <rect x="2.8" y="4.2" width="10.4" height="8.8" rx="2.6" />
      <line x1="1.5" y1="7.8" x2="2.8" y2="7.8" />
      <line x1="13.2" y1="7.8" x2="14.5" y2="7.8" />
      <circle cx="6.1" cy="8.1" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="9.9" cy="8.1" r="0.85" fill="currentColor" stroke="none" />
      <line x1="6.3" y1="10.6" x2="9.7" y2="10.6" />
    </svg>
  )
}

/**
 * Shield-check outline icon for the "飞书认证" button.
 */
export function ShieldAuthIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.15}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M8 1.75L13.1 3.7V7.65C13.1 10.95 10.95 13.38 8 14.35C5.05 13.38 2.9 10.95 2.9 7.65V3.7L8 1.75Z" />
      <path d="M5.85 8.05L7.35 9.55L10.35 6.45" />
    </svg>
  )
}
