/**
 * Left-facing (`↖`) geometric paper-plane icon for the DSH sidebar.
 * Symmetric along the upper-left diagonal (`2.1, 2.1` → `8.5, 8.5`) with rounded
 * wing tips and `currentColor` 1px-class strokes matching sibling DSH icons.
 */
export function LarkSidebarIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.08}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M2.28 2.02L13.92 6.08C14.32 6.22 14.35 6.77 13.97 6.96L8.72 9.52L6.16 14.77C5.97 15.15 5.42 15.12 5.28 14.72L1.82 2.48C1.71 2.11 1.92 1.89 2.28 2.02Z" transform="translate(0.35, -0.35) scale(0.95)" />
      <path d="M2.25 2.05L8.62 9.42" transform="translate(0.35, -0.35) scale(0.95)" />
    </svg>
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
