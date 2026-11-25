const STYLE_ELEMENT_ID = 'dsh-lark-bridge-styles'

/**
 * Page-level layout only. Controls come from `@deepseek-ai/dsh-client-ui-primitives`;
 * the rules here mirror DSH's settings and task pages and use `--dsw-*` tokens,
 * so light and dark themes follow the host automatically.
 */
const CSS = `
.fb-page {
  height: 100%;
  overflow-y: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 14px;
  line-height: 22px;
}
.fb-container {
  max-width: calc(960px + 2 * clamp(24px, 4vw, 48px));
  margin: 0 auto;
  padding: calc(28px + var(--dsh-frame-top-clearance, 0px)) clamp(24px, 4vw, 48px) 48px;
  box-sizing: border-box;
}
.fb-mono { font-family: var(--ds-font-family-code); font-size: 12.5px; }
.fb-num { font-variant-numeric: tabular-nums; }

/* Header & monochrome DSH icon tab bar */
.fb-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; margin-bottom: 14px; }
.fb-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
.fb-title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  perspective: 140px;
}
.fb-title-icon-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform-origin: center;
  transform-style: preserve-3d;
  will-change: transform;
  animation: fb-title-icon-flip 5.6s cubic-bezier(0.42, 0, 0.22, 1) infinite;
}
@keyframes fb-title-icon-flip {
  0%, 10% { transform: rotateY(0deg); }
  24%, 32% { transform: rotateY(180deg); }
  46%, 100% { transform: rotateY(0deg); }
}
@media (prefers-reduced-motion: reduce) {
  .fb-title-icon-glyph { animation: none; }
}
.fb-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.fb-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-bottom: 10px;
  margin-bottom: 22px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  flex-wrap: wrap;
}
.fb-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 12px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 14px;
  line-height: 20px;
  font-weight: 400;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fb-tab[aria-current='page'] {
  background: var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-button-ghost-active-fill));
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
@media (hover: hover) {
  .fb-tab:hover:not([aria-current='page']) {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}
.fb-tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}

/* Sections & lists (settings card language) */
.fb-section + .fb-section { margin-top: 28px; }
.fb-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; min-height: 28px; }
.fb-section-title { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.fb-card {
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1));
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2));
}
.fb-list { padding: 0 18px; }
.fb-item { display: flex; align-items: center; gap: 12px; min-height: 40px; padding: 14px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.fb-item:last-child { border-bottom: none; }
.fb-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.fb-item-title { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; line-height: 22px; }
.fb-item-title > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-item-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.fb-item-side { display: flex; align-items: center; gap: 8px; flex: none; }
.fb-item-time { font-size: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.fb-avatar {
  flex: none; width: 32px; height: 32px; overflow: hidden;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  font-size: 13px; font-weight: 500;
}
.fb-avatar[data-sm] { width: 24px; height: 24px; font-size: 11px; border-radius: 6px; }
.fb-avatar[data-chip] { width: 16px; height: 16px; font-size: 10px; border-radius: 50%; }
.fb-avatar[data-kind='bot']:not([data-has-img]) { color: var(--dsw-alias-label-primary); opacity: 0.85; }
.fb-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fb-empty { padding: 40px 16px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.fb-empty-stack { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.fb-schedule-hint {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
  margin: -2px 0 12px; padding: 0 2px;
  font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
}
.fb-schedule-hint[data-dialog] {
  margin: 0 0 4px; padding: 0;
}
.fb-inline-jump {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 1px 5px; border: none; border-radius: 4px; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; font-weight: 500;
  cursor: pointer; transition: background 120ms ease;
}
.fb-view-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 12px;
  margin-bottom: 12px;
}
.fb-view-bar-right {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.fb-toolbar .fb-search { flex: 1; min-width: 0; height: 36px; padding: 0 12px; gap: 8px; }
.fb-toolbar .fb-search input::placeholder { color: var(--dsw-alias-label-tertiary); opacity: 1; }

/* Segmented switch with muted count & borderless status filter tabs (matches DSH TaskManagerPage) */
.fb-seg {
  position: relative;
  display: inline-grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 2px;
  padding: 4px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover);
}
.fb-seg-indicator {
  position: absolute;
  top: 4px;
  left: 4px;
  width: calc((100% - 8px - 2px * (var(--fb-seg-count, 2) - 1)) / var(--fb-seg-count, 2));
  height: calc(100% - 8px);
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-soft);
  transform: translateX(calc(var(--fb-seg-index, 0) * (100% + 2px)));
  transition: transform 160ms ease;
  pointer-events: none;
}
.fb-seg-tab {
  box-sizing: border-box;
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: color 120ms ease;
}
.fb-seg-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); }
.fb-tab-count {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12.5px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.fb-filter-tabs {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.fb-filter-tab {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fb-filter-tab[aria-pressed='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
@media (hover: hover) {
  .fb-seg-tab:hover { color: var(--dsw-alias-label-primary); }
  .fb-filter-tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
.fb-seg-tab:focus-visible, .fb-filter-tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
@media (prefers-reduced-motion: reduce) {
  .fb-seg-indicator, .fb-seg-tab, .fb-filter-tab { transition: none; }
}

/* Overview */
.fb-alert-card { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.fb-alert-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.fb-alert-row + .fb-alert-row { padding-top: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.fb-alert-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.fb-alert-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13.5px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.fb-alert-detail { font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.fb-alert-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.fb-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.fb-stat { padding: 16px 18px; }
.fb-stat-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.fb-stat-value { margin-top: 6px; font-size: 24px; line-height: 32px; font-weight: 500; font-variant-numeric: tabular-nums; }
.fb-stat-unit { margin-left: 2px; font-size: 13px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.fb-stat-foot { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.fb-chart { padding: 14px 18px 12px; }
.fb-chart-legend { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.fb-legend-item { display: inline-flex; align-items: center; gap: 5px; }
.fb-swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.fb-swatch[data-kind='inbound'] { background: var(--dsw-alias-label-primary); opacity: 0.85; }
.fb-swatch[data-kind='replied'] { background: var(--dsw-alias-label-secondary); opacity: 0.45; }
.fb-swatch[data-kind='error'] { background: var(--dsw-alias-state-error-primary); }
.fb-chart-caption { margin-bottom: 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); min-height: 18px; }
.fb-chart-caption strong { font-weight: 500; color: var(--dsw-alias-label-primary); }
.fb-bars { display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); align-items: end; gap: 4px; height: 108px; }
.fb-bar-col { height: 100%; display: flex; flex-direction: column; gap: 3px; min-width: 0; cursor: default; }
.fb-bar-val { height: 14px; text-align: center; font-size: 10.5px; line-height: 14px; color: var(--dsw-alias-label-secondary); }
.fb-bar-col[data-active] .fb-bar-val { color: var(--dsw-alias-label-primary); font-weight: 500; }
.fb-bar { position: relative; flex: 1; display: flex; flex-direction: column; justify-content: flex-end; border-radius: 4px; background: var(--dsw-alias-bg-module-platform); overflow: hidden; transition: box-shadow 120ms ease; }
.fb-bar[data-current] { box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3); }
.fb-bar-col[data-active] .fb-bar { box-shadow: inset 0 0 0 1px var(--dsw-alias-label-secondary); }
.fb-bar-fill { background: var(--dsw-alias-label-primary); opacity: 0.85; border-radius: 2px 2px 0 0; }
.fb-bar-reply { background: var(--dsw-alias-label-secondary); opacity: 0.45; border-radius: 2px 2px 0 0; }
.fb-bar-error { background: var(--dsw-alias-state-error-primary); }
.fb-bar-axis { display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); gap: 4px; margin-top: 6px; font-size: 10.5px; line-height: 14px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.fb-bar-axis > span:last-child { text-align: right; }
.fb-split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 860px) {
  .fb-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fb-split { grid-template-columns: 1fr; }
}

/* Settings rows (mirrors DSH settings: title + description left, control right) */
.fb-row { display: flex; align-items: center; gap: 12px; padding: 16px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.fb-row:last-child, .fb-row:has(+ .fb-group-title) { border-bottom: none; }
.fb-row[data-stack] { flex-direction: column; align-items: stretch; gap: 10px; }
.fb-row-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.fb-row-head-actions { display: inline-flex; align-items: center; gap: 4px; flex: none; margin-top: -2px; }
.fb-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding-right: 36px; }
.fb-row-title { font-size: 14px; line-height: 22px; }
.fb-row-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.fb-row-control { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px; max-width: 58%; }
.fb-group-title { margin: 22px 0 2px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-tertiary); }
.fb-group-title:first-child { margin-top: 4px; }

/* Cascading child configuration container (thin left guide line matching row divider, no background) */
.fb-row:has(+ .fb-nested) {
  border-bottom: none;
  padding-bottom: 10px;
}
.fb-nested {
  margin: 2px 0 16px 14px;
  padding: 0 0 0 16px;
  border-left: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-nested:last-child {
  margin-bottom: 4px;
}
.fb-nested > .fb-row:first-child {
  padding-top: 2px;
}
.fb-nested > .fb-group-title:first-child {
  margin-top: 2px;
}
.fb-nested > .fb-row:last-child {
  padding-bottom: 2px;
  border-bottom: none;
}
.fb-nested + .fb-row {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-nested .fb-nested {
  margin: 2px 0 12px 14px;
}

/* Unified editable scope tags & directory picker */
.fb-scope-items { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.fb-scope-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 6px 0 10px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-module-platform);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2); font-size: 13px; line-height: 20px;
  transition: box-shadow 120ms ease, background 120ms ease;
}
.fb-scope-chip[data-editing] {
  padding: 0 8px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary);
}
.fb-scope-chip-text {
  cursor: text; padding: 1px 2px; border-radius: 3px; color: var(--dsw-alias-label-primary);
}
.fb-scope-chip input {
  min-width: 84px; max-width: 240px; height: 22px; padding: 0; border: none; outline: none;
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
}
.fb-scope-chip button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; padding: 0; border: none; border-radius: 4px;
  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer;
}
.fb-scope-add-btn {
  display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px;
  border: 0.5px dashed var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12.5px; cursor: pointer;
}
.fb-scope-add { display: flex; align-items: center; gap: 6px; }
.fb-scope-add .fb-field { flex: 1; width: auto; height: 32px; font-size: 13px; }

.fb-dir-control {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  width: 260px;
  max-width: 100%;
  height: 36px;
  padding: 0 4px 0 14px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
}
.fb-dir-control:focus-within {
  box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary);
}
.fb-dir-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 6px 0 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
}
.fb-dir-input::placeholder {
  color: var(--dsw-alias-label-secondary);
  opacity: 0.85;
}
.fb-dir-input:disabled {
  color: var(--dsw-alias-label-secondary);
  cursor: default;
  opacity: 1;
}
.fb-dir-browse {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fb-dir-browse:disabled {
  cursor: default;
  opacity: 0.4;
}
.fb-dir-browse:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.fb-dir-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.fb-dir-crumbs {
  display: flex; align-items: center; flex-wrap: wrap; gap: 2px;
  padding: 6px 10px; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform); font-size: 12.5px;
}
.fb-dir-crumb {
  padding: 2px 6px; border: none; border-radius: 4px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12.5px; cursor: pointer;
}
.fb-dir-crumb[data-current] { color: var(--dsw-alias-label-primary); font-weight: 500; }
.fb-dir-sep { color: var(--dsw-alias-label-tertiary); font-size: 11px; user-select: none; }
.fb-dir-list {
  margin-top: 8px; height: 268px; overflow-y: auto; padding: 4px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform);
}
.fb-dir-entry {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 34px; padding: 0 10px;
  border: none; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer;
}
.fb-dir-entry[data-hidden] { color: var(--dsw-alias-label-tertiary); }
.fb-dir-entry-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (hover: hover) {
  .fb-dir-browse:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
  .fb-dir-entry:hover, .fb-dir-crumb:hover, .fb-scope-chip button:hover, .fb-scope-add-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
  .fb-scope-chip:not([data-editing]):hover {
    box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3, var(--dsw-alias-label-tertiary));
  }
}

/* Field atoms: legible default/placeholder values */
.fb-select, .fb-field {
  box-sizing: border-box; height: 36px;
  border: none; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 14px; line-height: 22px;
}
.fb-select { display: inline-flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 112px; max-width: 280px; padding: 0 14px; cursor: pointer; }
.fb-select[data-size='sm'] { height: 32px; min-width: 96px; gap: 8px; padding: 0 12px; font-size: 13px; }
.fb-select:disabled { cursor: default; color: var(--dsw-alias-label-secondary); opacity: 1; }
.fb-select-label { display: inline-flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fb-select-chevron { flex: none; color: var(--dsw-alias-label-secondary); }
.fb-field { width: 260px; padding: 0 14px; outline: none; }
.fb-field[data-wide] { width: 100%; }
.fb-field[type='number'] { appearance: textfield; -moz-appearance: textfield; }
.fb-field[type='number']::-webkit-inner-spin-button,
.fb-field[type='number']::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.fb-field::placeholder,
.fb-textarea::placeholder,
.fb-tags input::placeholder,
.fb-picker .fb-search input::placeholder {
  color: var(--dsw-alias-label-secondary);
  opacity: 0.85;
}
.fb-field:focus, .fb-textarea:not([readonly]):focus, .fb-tags:focus-within { box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary); }
.fb-field:disabled, .fb-textarea[readonly], .fb-textarea:disabled { color: var(--dsw-alias-label-secondary); cursor: default; opacity: 1; }
.fb-field-suffix { display: inline-flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.fb-field-suffix .fb-field { width: 88px; text-align: center; padding: 0 10px; }
.fb-textarea {
  box-sizing: border-box; width: 100%; min-height: 132px; padding: 10px 14px; resize: vertical;
  border: none; border-radius: var(--dsw-radius-md); outline: none;
  background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px;
}
.fb-tags {
  box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  min-height: 36px; padding: 6px 10px; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
}
.fb-tags input { flex: 1; min-width: 120px; height: 24px; padding: 0 4px; border: none; outline: none; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
.fb-tag-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 5px 0 9px;
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3); font-size: 12px;
}
.fb-tag-chip img { width: 16px; height: 16px; border-radius: 50%; object-fit: cover; }
.fb-tag-chip button { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: none; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; border-radius: 4px; }
.fb-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.fb-emoji { width: 18px; height: 18px; object-fit: contain; display: block; flex: none; }
.fb-option { display: inline-flex; align-items: center; gap: 8px; line-height: 20px; }
.fb-choice-opt { display: flex; flex-direction: column; gap: 2px; max-width: 300px; min-width: 0; padding: 2px 0; white-space: normal; }
.fb-choice-opt-label { font-size: 13px; line-height: 19px; color: var(--dsw-alias-label-primary); }
.fb-choice-opt-desc { font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-rt-opt { display: flex; flex-direction: column; gap: 2px; width: 256px; max-width: 100%; min-width: 0; padding: 1px 0; }
.fb-rt-opt-name { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-rt-opt-desc { display: block; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-rt-opt-desc-track { display: inline; }
:is([role='menuitem']:hover, [role='menuitem']:focus-visible) .fb-rt-opt[data-overflow] .fb-rt-opt-desc,
.fb-rt-opt[data-overflow]:hover .fb-rt-opt-desc { text-overflow: clip; }
:is([role='menuitem']:hover, [role='menuitem']:focus-visible) .fb-rt-opt[data-overflow] .fb-rt-opt-desc-track,
.fb-rt-opt[data-overflow]:hover .fb-rt-opt-desc-track {
  display: inline-block;
  will-change: transform;
  animation: fb-rt-desc-marquee var(--fb-marquee-dur, 6s) linear infinite;
}
@keyframes fb-rt-desc-marquee {
  0%, 8% { transform: translateX(0); }
  78%, 94% { transform: translateX(var(--fb-marquee-dist, 0px)); }
  100% { transform: translateX(0); }
}
@media (prefers-reduced-motion: reduce) {
  :is([role='menuitem']:hover, [role='menuitem']:focus-visible) .fb-rt-opt[data-overflow] .fb-rt-opt-desc-track,
  .fb-rt-opt[data-overflow]:hover .fb-rt-opt-desc-track { animation: none; }
}

/* User search picker & member switch rows */
.fb-picker { position: relative; display: flex; flex-direction: column; gap: 8px; }
.fb-picker-results {
  max-height: 210px; overflow-y: auto; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2), 0 6px 20px rgba(0, 0, 0, 0.08);
  padding: 4px;
}
.fb-picker-item {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px;
  border: none; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer;
}
.fb-picker-item:disabled { opacity: 0.5; cursor: default; }
.fb-picker-meta { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-member-box {
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  padding: 4px 14px;
  max-height: 260px;
  overflow-y: auto;
}
.fb-member-item {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 9px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-member-item:last-child { border-bottom: none; }
.fb-member-left { display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1; }
.fb-member-name { font-size: 13.5px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-inline-actions { display: inline-flex; align-items: center; gap: 6px; }
.fb-link-btn {
  padding: 2px 6px; border: none; border-radius: 4px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer;
}
.fb-var-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.fb-var-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 9px;
  border: none; border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px;
  cursor: pointer; transition: background 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
.fb-var-chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.fb-code-preview {
  margin: 0;
  padding: 10px 14px;
  max-height: 220px;
  overflow: auto;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
}
.fb-schema-params {
  display: flex;
  flex-direction: column;
  margin-bottom: 12px;
  padding: 0 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
}
.fb-schema-param {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-schema-param:last-child { border-bottom: none; }
.fb-schema-param-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12.5px;
  line-height: 18px;
}
@media (hover: hover) {
  .fb-var-chip:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
    box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3, var(--dsw-alias-label-tertiary));
  }
}

/* QR code & auto-create box */
.fb-qr-panel {
  display: flex; align-items: center; gap: 18px; padding: 16px;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform);
}
.fb-qr-img { width: 148px; height: 148px; border-radius: 8px; background: #ffffff; padding: 6px; box-sizing: border-box; flex: none; }
.fb-qr-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.fb-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px; border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform); font-size: 13px;
}
.fb-banner > :first-child { flex: 1; min-width: 0; }
.fb-dream-card {
  margin: 6px 0 2px;
  padding: 12px 14px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
}
.fb-dream-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.fb-dream-desc {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-dream-actions {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.fb-dream-actions button {
  white-space: nowrap;
}
.fb-dream-status {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.fb-dream-status-dot {
  flex: none;
  height: 20px;
  display: inline-flex;
  align-items: center;
}
.fb-dream-status-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.fb-dream-status-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.fb-dream-status-title {
  min-width: 0;
  font-size: 12.5px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.fb-dream-status-title[data-error] {
  color: var(--dsw-alias-state-error-primary);
}
.fb-dream-inline-link {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 22px;
  padding: 0 6px;
  margin-right: -6px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fb-dream-status-note {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.fb-banner button,
.fb-toolbar > button,
.fb-dir-toolbar button,
.fb-row-control > button,
.fb-scope-add > button,
.fb-item-side button,
.fb-actions button,
.fb-dialog-footer button,
.fb-schedule-dialog-foot button {
  flex: none;
  white-space: nowrap;
}

/* Floating config dialog (mirrors DSH SettingsRoot 800px panel) */
.fb-dialog.fb-dialog {
  display: grid; grid-template-columns: 188px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto;
  grid-template-areas: 'header header' 'nav options' 'nav footer';
  width: 800px; max-width: calc(100vw - 48px);
  height: min(680px, calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px))));
  max-height: 100%; padding: 0; gap: 0;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.fb-dialog-header {
  grid-area: header; display: flex; align-items: center; justify-content: space-between;
  gap: 12px; min-height: 54px; padding: 18px 14px 8px 24px; box-sizing: border-box;
}
.fb-dialog-header-main {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px;
}
.fb-dialog-back {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 28px;
  padding: 0 8px 0 4px;
  margin-left: -6px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13.5px;
  line-height: 20px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fb-dialog-header-sep {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  user-select: none;
}
.fb-dialog-title {
  flex: 1; min-width: 0; font-size: 16px; line-height: 24px; font-weight: 500;
  overflow-wrap: anywhere; word-break: break-word;
}
.fb-dialog-nav { grid-area: nav; display: flex; flex-direction: column; gap: 4px; min-height: 0; padding: 10px 12px 16px; overflow-y: auto; }
.fb-nav-cell {
  display: flex; align-items: center; gap: 8px; height: 40px; padding: 9px 16px 9px 12px; box-sizing: border-box;
  border: none; border-radius: var(--dsw-radius-md); background: transparent; cursor: pointer; text-align: left;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px;
}
.fb-nav-icon { display: inline-flex; flex: none; color: var(--dsw-alias-label-secondary); }
.fb-nav-cell[aria-current='page'] { background: var(--dsw-specific-sidebar-nav-item-active); }
.fb-nav-cell[aria-current='page'] .fb-nav-icon { color: var(--dsw-alias-label-primary); }
.fb-dialog-options { grid-area: options; min-width: 0; min-height: 0; padding: 0 28px 24px 24px; overflow-y: auto; }
.fb-dialog-footer { grid-area: footer; display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin: 0 28px 0 24px; padding: 14px 0 20px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.fb-dialog-error { margin-right: auto; font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.fb-dialog-notice { margin-right: auto; font-size: 12px; color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary)); }

/* Suppress double-darkened backdrop when an auxiliary picker modal opens over a parent modal */
body > [role='presentation']:has(> [role='dialog'][aria-modal='true'])
  ~ [role='presentation']:has(> [role='dialog'][aria-modal='true'].fb-nested-modal) > [aria-hidden='true'] {
  backdrop-filter: none;
}
body > [role='presentation']:has(> [role='dialog'][aria-modal='true'])
  ~ [role='presentation']:has(> [role='dialog'][aria-modal='true'].fb-nested-modal) > [aria-hidden='true']::after {
  background: transparent;
}

/* Runtime launch profile manager panel */
.fb-profile-new-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  margin-bottom: 4px;
  border: 0.5px dashed var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fb-profile-new-btn[aria-current='page'] {
  border-style: solid;
  border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  background: var(--dsw-specific-sidebar-nav-item-active);
  color: var(--dsw-alias-label-primary);
}
.fb-profile-nav-item { justify-content: space-between; padding-right: 10px; }
.fb-profile-nav-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-import-bar { padding: 4px 0 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); margin-bottom: 8px; }
.fb-import-box { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.fb-import-textarea { min-height: 60px; padding: 8px 12px; font-size: 12.5px; line-height: 19px; resize: vertical; }
.fb-import-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fb-import-foot > button { flex: none; white-space: nowrap; }
.fb-collapse-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 2px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.fb-env-editor { display: flex; flex-direction: column; gap: 8px; padding: 10px 0 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.fb-env-row { display: grid; grid-template-columns: minmax(216px, 46%) minmax(0, 1fr); align-items: center; gap: 8px; }
.fb-env-key { width: 100%; height: 36px; padding: 0 12px; font-size: 12.5px; }
.fb-env-val-box {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 4px 0 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
}
.fb-env-val-box:focus-within {
  box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary);
}
.fb-env-val-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 6px 0 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  line-height: 20px;
}
.fb-env-val-input::placeholder {
  color: var(--dsw-alias-label-secondary);
  opacity: 0.85;
}
.fb-env-remove {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fb-env-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 2px; }
.fb-env-hint-btn {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  cursor: pointer;
}
.fb-advanced-section { padding-top: 12px; }

/* Memory Library page & editor */
.fb-mem-section-note {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-list {
  padding: 0;
  overflow: hidden;
}
.fb-mem-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 20px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  transition: background 160ms ease, box-shadow 160ms ease;
}
.fb-mem-item:last-child {
  border-bottom: none;
}
.fb-mem-item[data-inactive] .fb-mem-title-btn,
.fb-mem-item[data-inactive] .fb-mem-body {
  opacity: 0.78;
}
.fb-mem-item[data-highlighted] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, transparent);
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary);
}
.fb-mem-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.fb-mem-title-group {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  padding-top: 2px;
}
.fb-mem-title-btn {
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14.5px;
  line-height: 22px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  word-break: break-word;
}
.fb-mem-actions {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.fb-mem-actions button {
  flex: none;
  white-space: nowrap;
}
.fb-mem-pin-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fb-mem-pin-btn[data-pinned] {
  color: var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
}
.fb-mem-pin-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.fb-mem-body {
  font-size: 13px;
  line-height: 21px;
  color: var(--dsw-alias-label-secondary);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  cursor: pointer;
}
.fb-mem-body[data-expanded] {
  display: block;
  overflow: visible;
  white-space: pre-wrap;
  color: var(--dsw-alias-label-primary);
  cursor: text;
}
.fb-mem-lineage {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 7px 11px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.fb-mem-lineage-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.fb-mem-detail-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 7px 11px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding-top: 2px;
}
.fb-mem-meta-left {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
}
.fb-mem-bot {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.fb-mem-scope {
  display: inline-flex;
  align-items: center;
  max-width: 240px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-mem-tags {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.fb-mem-tag-btn {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 11.5px;
  line-height: 18px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fb-mem-meta-right {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-expand-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 22px;
  padding: 0 6px;
  margin-left: 2px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fb-mem-mirror-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
  padding: 8px 14px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-mirror-text {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}
.fb-mem-mirror-text > span:first-child {
  flex: none;
}
.fb-mem-mirror-text .fb-mono {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.fb-memory-dialog.fb-memory-dialog {
  width: 600px;
  max-height: min(720px, calc(100vh - 48px));
}
.fb-mem-char-count {
  font-size: 11.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-char-count[data-over] {
  color: var(--dsw-alias-state-error-primary);
}
.fb-mem-supersede-ref {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 0 6px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
}
.fb-mem-supersede-ref-label {
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-supersede-ref-title {
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.fb-mem-supersede-ref-body {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.fb-schedule-dialog.fb-schedule-dialog {
  display: flex; flex-direction: column;
  width: 580px; max-width: calc(100vw - 48px);
  max-height: min(640px, calc(100vh - 48px));
  padding: 0; gap: 0;
}
.fb-create-bot-dialog.fb-create-bot-dialog {
  height: min(650px, calc(100vh - 48px));
  max-height: min(650px, calc(100vh - 48px));
}
.fb-row:has(+ .fb-op-apps-panel) {
  border-bottom: none;
  padding-bottom: 10px;
}
.fb-op-apps-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 0 14px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-op-apps-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.fb-op-apps-toolbar .fb-search {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  gap: 6px;
}
.fb-op-apps-toolbar .fb-search input::placeholder {
  color: var(--dsw-alias-label-tertiary);
  opacity: 1;
}
.fb-op-apps-toolbar > button {
  flex: none;
  white-space: nowrap;
}
.fb-op-apps-list {
  max-height: 214px;
  overflow-y: auto;
  padding: 4px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fb-op-apps-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 92px;
  padding: 16px 12px;
  text-align: center;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-op-app-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease, box-shadow 120ms ease;
}
.fb-op-app-item:disabled {
  opacity: 0.56;
  cursor: default;
}
.fb-op-app-item[data-selected] {
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary);
}
.fb-op-app-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.fb-op-app-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.fb-op-app-name {
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-op-app-meta {
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-op-app-check {
  flex: none;
  display: inline-flex;
  color: var(--dsw-alias-state-business-primary);
}
.fb-op-apps-note {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-schedule-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 16px 12px 24px; }
.fb-schedule-dialog-title { font-size: 16px; line-height: 24px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-schedule-dialog-sub { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.fb-schedule-dialog-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 24px 12px; }
.fb-schedule-dialog-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin: 0 24px; padding: 14px 0 20px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.fb-update-btn-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary);
  margin-left: 4px;
  vertical-align: middle;
}
.fb-update-env-title { display: inline-flex; align-items: center; gap: 8px; }
.fb-update-error {
  margin: 8px 0 12px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-state-error, var(--dsw-alias-label-primary));
  font-size: 12.5px;
  line-height: 18px;
}
.fb-update-op-card {
  margin: 8px 0 12px;
  padding: 12px 14px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-interactive-bg-hover));
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fb-update-op-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fb-update-op-msg { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.fb-update-op-items { display: flex; flex-direction: column; gap: 4px; }
.fb-update-op-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.fb-update-list { display: flex; flex-direction: column; }
.fb-update-plugin-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-update-plugin-row:last-child { border-bottom: none; }
.fb-update-plugin-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.fb-update-plugin-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; font-weight: 500; line-height: 20px; }
.fb-update-pkg { font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.fb-update-plugin-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.fb-update-link { color: var(--dsw-alias-label-primary); text-decoration: underline; text-underline-offset: 2px; }
.fb-update-plugin-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.fb-update-notes {
  margin: 4px 0 0;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 112px;
  overflow-y: auto;
}
.fb-update-plugin-action { flex: none; padding-top: 2px; }
.fb-icon-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0;
  border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
@media (hover: hover) {
  .fb-select:hover:not(:disabled), .fb-nav-cell:hover:not([aria-current='page']), .fb-icon-btn:hover, .fb-dialog-back:hover, .fb-env-remove:hover, .fb-tag-chip button:hover, .fb-picker-item:hover:not(:disabled), .fb-op-app-item:hover:not(:disabled):not([data-selected]), .fb-link-btn:hover, .fb-inline-jump:hover, .fb-profile-new-btn:hover, .fb-collapse-toggle:hover, .fb-env-hint-btn:hover, .fb-dream-inline-link:hover, .fb-mem-pin-btn:hover:not(:disabled), .fb-mem-tag-btn:hover, .fb-mem-expand-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
  .fb-mem-pin-btn[data-pinned]:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color: var(--dsw-alias-state-warn-primary); }
  .fb-mem-title-btn:hover { color: var(--dsw-alias-state-business-primary); }
}
.fb-select:focus-visible, .fb-icon-btn:focus-visible, .fb-dialog-back:focus-visible, .fb-env-remove:focus-visible, .fb-nav-cell:focus-visible, .fb-op-app-item:focus-visible, .fb-dream-inline-link:focus-visible, .fb-mem-pin-btn:focus-visible, .fb-mem-title-btn:focus-visible, .fb-mem-tag-btn:focus-visible, .fb-mem-expand-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
@media (max-width: 720px) {
  .fb-dialog.fb-dialog { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr) auto; grid-template-areas: 'header' 'nav' 'options' 'footer'; }
  .fb-dialog-header { padding: 18px 12px 6px 18px; }
  .fb-dialog-nav { flex-direction: row; overflow-x: auto; padding: 4px 16px 12px; }
  .fb-nav-cell { flex: none; }
  .fb-row-text { padding-right: 16px; }
  .fb-dialog-options { padding: 0 16px 20px; }
  .fb-dialog-footer { margin: 0 16px; }
  .fb-env-row { grid-template-columns: minmax(0, 1fr); }
}
`

export function ensureLarkUiStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(STYLE_ELEMENT_ID)
  if (existing) {
    if (existing.textContent !== CSS) existing.textContent = CSS
    return
  }
  const el = document.createElement('style')
  el.id = STYLE_ELEMENT_ID
  el.textContent = CSS
  document.head.appendChild(el)
}
