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
  scrollbar-gutter: stable;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 14px;
  line-height: 22px;
}
.fb-container {
  width: 100%;
  margin: 0 auto;
  padding: calc(28px + var(--dsh-frame-top-clearance, 0px)) clamp(24px, 3vw, 48px) 36px;
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

/* Overview alerts */
.fb-alert-card { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.fb-alert-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.fb-alert-row + .fb-alert-row { padding-top: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.fb-alert-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.fb-alert-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13.5px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.fb-alert-detail { font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.fb-alert-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

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
.fb-dir-head {
  padding-bottom: 10px;
}
.fb-dir-head-main {
  flex: 1;
  min-width: 0;
}
.fb-dir-path {
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-dir-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 24px 12px;
  overflow: hidden;
}
.fb-dir-body > .fb-scope-add {
  flex: none;
}
.fb-dir-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.fb-dir-toolbar-left {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.fb-dir-toolbar-left > button:first-child {
  margin-left: -10px;
}
.fb-dir-toggle[aria-pressed='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.fb-dir-crumbs {
  flex: none;
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
.fb-dir-search {
  flex: none;
  margin-top: 8px;
}
.fb-dir-search .fb-search,
.fb-picker .fb-search {
  display: flex;
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  gap: 6px;
}
.fb-dir-search .fb-search input::placeholder {
  color: var(--dsw-alias-label-tertiary);
  opacity: 1;
}
.fb-dir-list {
  flex: 1;
  min-height: 220px;
  margin-top: 8px;
  overflow-y: auto;
  padding: 4px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
}
.fb-dir-entry {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 34px; padding: 0 10px;
  border: none; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer;
}
.fb-dir-entry-icon { flex: none; color: var(--dsw-alias-label-secondary); }
.fb-dir-entry[data-hidden] { color: var(--dsw-alias-label-tertiary); }
.fb-dir-entry[data-hidden] .fb-dir-entry-icon { color: var(--dsw-alias-label-tertiary); }
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
.fb-select-anchor { max-width: 100%; min-width: 0; }
.fb-select-anchor-full { display: flex; width: 100%; }
.fb-select { display: inline-flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 112px; max-width: min(280px, 100%); padding: 0 14px; cursor: pointer; }
.fb-select[data-size='sm'] { height: 32px; min-width: 96px; gap: 8px; padding: 0 12px; font-size: 13px; }
.fb-select[data-full] { width: 100%; min-width: 0; max-width: 100%; }
.fb-select:disabled { cursor: default; color: var(--dsw-alias-label-secondary); opacity: 1; }
.fb-select-label { display: block; flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: left; }
.fb-select-label[data-node] { display: inline-flex; align-items: center; gap: 8px; }
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
.fb-textarea-compact { min-height: 76px; }
.fb-row-head-actions .fb-select { max-width: 240px; }
.fb-gen-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: 32px;
}
.fb-gen-status {
  display: inline-flex; align-items: center; flex-wrap: wrap; gap: 8px;
  min-width: 0; flex: 1;
}
.fb-gen-actions {
  display: inline-flex; align-items: center; gap: 8px; flex: none;
}
.fb-gen-error {
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error);
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
.fb-dialog-subview-single {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.fb-dir-modal .fb-dir-list,
.fb-memory-dialog .fb-dir-list {
  height: 280px;
}
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

/* Memory Library inside unified adaptive .fb-container (100% --dsw-* tokens) */
.fb-mem-shell {
  display: flex;
  flex-direction: column;
}
.fb-mem-frame {
  container-type: inline-size;
  border-radius: var(--dsw-radius-lg);
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2));
  background: var(--dsw-alias-bg-base);
  overflow: hidden;
  box-sizing: border-box;
  height: max(540px, calc(100vh - 224px - var(--dsh-frame-top-clearance, 0px)));
  position: relative;
}
.fb-mem-workspace {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: clamp(200px, 17cqi, 248px) clamp(248px, 24cqi, 360px) minmax(0, 1fr);
  background: var(--dsw-alias-bg-base);
}
.fb-mem-graph-search {
  width: 224px;
  height: 32px;
  transition: box-shadow 140ms ease, width 180ms ease;
}
.fb-mem-graph-search:focus-within {
  width: 264px;
}

/* Obsidian-inspired Interactive Memory Graph Stage */
.fb-mem-graph-stage {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  user-select: none;
}
.fb-mem-graph-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
}
.fb-mem-graph-canvas[data-cursor='drag'] {
  cursor: grabbing;
}
.fb-mem-graph-canvas[data-cursor='hover'] {
  cursor: pointer;
}
.fb-mem-graph-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 24px;
  text-align: center;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
  pointer-events: auto;
}
.fb-mem-graph-controls {
  position: absolute;
  top: 12px;
  right: 12px;
  bottom: 12px;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
  transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.fb-mem-graph-controls > * {
  pointer-events: auto;
}
.fb-mem-graph-stage[data-drawer] .fb-mem-graph-controls {
  transform: translateX(-450px);
}
.fb-mem-graph-iconbar {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2), var(--dsw-elevation-soft);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.fb-mem-graph-iconbtn {
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
  transition: background 110ms ease, color 110ms ease;
}
.fb-mem-graph-iconbtn:disabled {
  opacity: 0.4;
  cursor: default;
}
.fb-mem-graph-iconbtn[aria-pressed='true'] {
  background: color-mix(in srgb, var(--dsw-alias-state-done-primary) 16%, transparent);
  color: var(--dsw-alias-state-done-primary);
}
.fb-mem-graph-panel {
  width: 256px;
  min-height: 0;
  overflow-y: auto;
  border-radius: var(--dsw-radius-lg);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 94%, transparent);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2), var(--dsw-elevation-soft);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  padding: 4px 0;
}
.fb-mem-graph-acc {
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  padding: 4px 12px 8px;
}
.fb-mem-graph-acc:last-child {
  border-bottom: none;
  padding-bottom: 4px;
}
.fb-mem-graph-acc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 0;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.fb-mem-graph-acc-body {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-top: 4px;
}
.fb-mem-graph-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.fb-mem-graph-group-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: calc(100% + 12px);
  margin: 0 -6px;
  padding: 4px 6px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 110ms ease, color 110ms ease;
}
.fb-mem-graph-group-row[aria-pressed='true'] {
  background: var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.fb-mem-graph-group-left {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.fb-mem-graph-tag-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-label-tertiary);
  box-sizing: border-box;
  flex: none;
}
.fb-mem-graph-slider {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}
.fb-mem-graph-slider-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-graph-slider input[type='range'] {
  width: 100%;
  height: 4px;
  accent-color: var(--dsw-alias-state-done-primary);
  cursor: pointer;
  margin: 2px 0;
}
.fb-mem-graph-stat {
  position: absolute;
  left: 14px;
  bottom: 12px;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  pointer-events: none;
}
.fb-mem-graph-tl {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
}
.fb-mem-graph-tl-track {
  width: 84px;
  height: 3px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  overflow: hidden;
}
.fb-mem-graph-tl-fill {
  height: 100%;
  background: var(--dsw-alias-state-done-primary);
  transition: width 80ms linear;
}
.fb-mem-graph-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(440px, 92%);
  z-index: 8;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
  border-left: 0.5px solid var(--dsw-alias-border-l2);
  box-shadow: -8px 0 28px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  transform: translateX(102%);
  transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: none;
}
.fb-mem-graph-drawer[data-open] {
  transform: translateX(0);
  pointer-events: auto;
}
.fb-mem-graph-drawer > .fb-mem-col-reader {
  height: 100%;
}
.fb-mem-paper[data-compact] {
  padding: 20px 22px 28px;
}
.fb-mem-paper[data-compact] .fb-mem-paper-title {
  font-size: 17px;
  line-height: 25px;
  margin-bottom: 16px;
  padding-bottom: 14px;
}
.fb-mem-paper[data-compact] .fb-mem-paper-body {
  font-size: 13.5px;
  line-height: 1.78;
}
.fb-mem-graph-links {
  margin-top: 20px;
  padding-top: 14px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-mem-graph-links-head {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-tertiary);
  margin-bottom: 8px;
}
.fb-mem-graph-links-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fb-mem-graph-link-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 12px);
  margin: 0 -6px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background 110ms ease;
}
.fb-mem-graph-link-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-mem-graph-link-meta {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
@media (prefers-reduced-motion: reduce) {
  .fb-mem-graph-controls,
  .fb-mem-graph-drawer {
    transition: none;
  }
}

/* Column 1: Clean taxonomy & scope hierarchy tree */
.fb-mem-col-nav {
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1));
  border-right: 0.5px solid var(--dsw-alias-border-l2);
  padding: 12px 8px 16px;
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.fb-mem-bot-select {
  min-width: 0;
}
.fb-mem-bot-select .fb-select {
  background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-bg-module-platform));
}
.fb-mem-bot-pill {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-bg-module-platform));
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.fb-mem-bot-pill-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-mem-nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fb-mem-nav-title {
  font-size: 11px;
  line-height: 16px;
  font-weight: 600;
  color: var(--dsw-alias-label-tertiary);
  padding: 0 8px 4px;
  letter-spacing: 0.02em;
}
.fb-mem-facet-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  transition: background 110ms ease, color 110ms ease;
}
.fb-mem-facet-row[aria-current='page'] {
  background: var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.fb-mem-facet-icon {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-facet-icon[data-pin] {
  color: var(--dsw-alias-state-warn-primary);
}
.fb-mem-facet-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-mem-facet-cnt {
  flex: none;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-type-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.fb-mem-type-dot[data-type='feedback'] {
  background: var(--dsw-alias-state-warn-primary);
}
.fb-mem-type-dot[data-type='user'] {
  background: var(--dsw-alias-state-business-primary);
}
.fb-mem-type-dot[data-type='project'] {
  background: var(--dsw-alias-state-success-primary);
}
.fb-mem-type-dot[data-type='reference'] {
  background: var(--dsw-alias-state-done-primary);
}
.fb-mem-tree-branch {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fb-mem-branch-row {
  display: flex;
  align-items: center;
  gap: 1px;
}
.fb-mem-branch-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.fb-mem-branch-toggle:disabled {
  opacity: 0.3;
  cursor: default;
}
.fb-mem-branch-spacer {
  flex: none;
  width: 20px;
}
.fb-mem-branch-main {
  flex: 1;
  min-width: 0;
  padding-left: 4px;
}
.fb-mem-tree-sub {
  margin-left: 11px;
  padding-left: 8px;
  border-left: 0.5px solid var(--dsw-alias-border-l2);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.fb-mem-scope-leaf {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 27px;
  padding: 0 7px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
  transition: background 110ms ease, color 110ms ease;
}
.fb-mem-scope-leaf[aria-current='page'] {
  background: var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.fb-mem-scope-leaf-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-mem-tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 4px;
}
.fb-mem-mini-tag {
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
  cursor: pointer;
  transition: background 110ms ease, color 110ms ease;
}
.fb-mem-mini-tag[aria-pressed='true'] {
  background: var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.fb-mem-tag-more {
  color: var(--dsw-alias-label-secondary);
}

/* Column 2: Scannable note digest list */
.fb-mem-col-list {
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
  border-right: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-mem-list-head {
  flex: none;
  padding: 12px 14px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fb-mem-list-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.fb-mem-list-heading {
  min-width: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.fb-mem-list-heading-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-mem-list-heading-cnt {
  flex: none;
  font-size: 12px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-sort-wrap .fb-select {
  height: 26px;
  min-width: auto;
  padding: 0 7px;
  gap: 4px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.fb-mem-history-tabs .fb-filter-tabs {
  gap: 4px;
}
.fb-mem-history-tabs .fb-filter-tab {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
  line-height: 18px;
}
.fb-mem-col-search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 9px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-col-search:focus-within {
  box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary);
}
.fb-mem-search-icon {
  flex: none;
}
.fb-mem-col-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
}
.fb-mem-col-search input::placeholder {
  color: var(--dsw-alias-label-tertiary);
  opacity: 1;
}
.fb-mem-search-clear {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.fb-mem-note-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  outline: none;
}
.fb-mem-list-empty {
  padding: 40px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  font-size: 12.5px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-note-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 9px 11px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  transition: background 100ms ease;
}
.fb-mem-note-card[data-active] {
  background: var(--dsw-alias-bg-module-platform);
}
.fb-mem-note-card[data-inactive] .fb-mem-note-title {
  opacity: 0.72;
}
.fb-mem-note-cat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 500;
}
.fb-mem-note-cat[data-type='feedback'] {
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
}
.fb-mem-note-cat[data-type='user'] {
  color: var(--dsw-alias-state-business-primary);
}
.fb-mem-note-cat[data-type='project'] {
  color: var(--dsw-alias-state-success-primary);
}
.fb-mem-note-cat[data-type='reference'] {
  color: var(--dsw-alias-state-done-primary);
}
.fb-mem-note-title {
  font-size: 13px;
  line-height: 19px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.fb-mem-note-card[data-active] .fb-mem-note-title {
  font-weight: 600;
}
.fb-mem-note-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  min-width: 0;
}
.fb-mem-note-meta-left {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.fb-mem-note-time {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-note-pin {
  color: var(--dsw-alias-state-warn-primary);
}
.fb-mem-status-chip {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  line-height: 16px;
}
.fb-mem-note-scope {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Column 3: Distraction-free editorial reading paper */
.fb-mem-col-reader {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
}
.fb-mem-reader-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 24px;
  text-align: center;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-reader-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 18px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-mem-reader-crumb {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-mem-reader-tools {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.fb-mem-tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 110ms ease, color 110ms ease;
}
.fb-mem-tool-btn[data-pinned] {
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  font-weight: 500;
}
.fb-mem-tool-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.fb-mem-reader-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.fb-mem-paper {
  max-width: 780px;
  width: 100%;
  margin: 0 auto;
  padding: 28px clamp(24px, 4cqi, 44px) 44px;
  box-sizing: border-box;
}
.fb-mem-paper-eyebrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-bottom: 10px;
}
.fb-mem-paper-kicker {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12.5px;
  line-height: 18px;
}
.fb-mem-paper-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-paper-title {
  margin: 0 0 22px;
  padding-bottom: 18px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  font-size: 19px;
  line-height: 28px;
  font-weight: 700;
  letter-spacing: -0.015em;
  color: var(--dsw-alias-label-primary);
  word-break: break-word;
}
.fb-mem-lineage-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-bottom: 20px;
  padding: 10px 14px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12.5px;
  line-height: 19px;
  color: var(--dsw-alias-label-secondary);
}
.fb-mem-lineage-banner .fb-mem-foot-action {
  margin-left: 0;
  margin-right: -6px;
}
.fb-mem-paper-body {
  font-size: 14.5px;
  line-height: 1.85;
  color: var(--dsw-alias-label-primary);
  word-break: break-word;
}
.fb-mem-paper-body p {
  margin: 0 0 14px;
}
.fb-mem-paper-body p:last-child {
  margin-bottom: 0;
}
.fb-mem-paper-body ul,
.fb-mem-paper-body ol {
  margin: 8px 0 16px;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.fb-mem-paper-body li::marker {
  color: var(--dsw-alias-label-tertiary);
}
.fb-mem-paper-body code {
  font-family: var(--ds-font-family-code);
  font-size: 12.5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
}
.fb-mem-paper-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 22px;
}
.fb-mem-paper-tag {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: background 110ms ease, color 110ms ease;
}
.fb-mem-paper-foot {
  margin-top: 24px;
  padding-top: 14px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 18px;
}
.fb-mem-foot-action {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px 6px;
  margin-left: -6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
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
.fb-update-op-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-update-force-confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 0.5px solid var(--dsw-alias-border-l2);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.fb-update-force-confirm-btns {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.fb-update-busy-banner {
  margin: 6px 0 10px;
  padding: 9px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-interactive-bg-hover));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12.5px;
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

/* Cockpit Telemetry ("驾驶舱") — precision telemetry visual language using DSH tokens */
.fb-obs-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.fb-obs-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.fb-obs-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 12px;
  min-height: 36px;
}
.fb-obs-bar-left,
.fb-obs-bar-right {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-obs-bar-right .fb-select {
  max-width: 204px;
}
.fb-obs-status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2);
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}
.fb-obs-pulse-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-success-primary) 24%, transparent);
  animation: fb-obs-pulse 2.4s ease-in-out infinite;
}
.fb-obs-pulse-dot[data-busy] {
  background: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent);
}
@keyframes fb-obs-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.85); }
}
.fb-obs-window-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2);
}
.fb-obs-window-btn {
  height: 26px;
  padding: 0 9px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  cursor: pointer;
  transition: background 110ms ease, color 110ms ease, box-shadow 110ms ease;
}
.fb-obs-window-btn[aria-pressed='true'] {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-soft);
}
.fb-obs-kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.fb-obs-kpi {
  padding: 13px 15px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.fb-obs-kpi-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 18px;
}
.fb-obs-kpi-label {
  font-size: 11.5px;
  line-height: 16px;
  font-weight: 500;
  letter-spacing: 0.03em;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.fb-obs-kpi-tag {
  font-size: 10.5px;
  line-height: 16px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.fb-obs-delta {
  font-size: 10.5px;
  line-height: 16px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.fb-obs-delta[data-tone='good'] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent);
  color: var(--dsw-alias-state-success-primary);
}
.fb-obs-delta[data-tone='bad'] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 13%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.fb-obs-kpi-mid {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.fb-obs-kpi-val {
  font-size: 21px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: -0.025em;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fb-obs-kpi-unit {
  margin-left: 3px;
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0;
  color: var(--dsw-alias-label-tertiary);
}
.fb-obs-kpi-foot {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-obs-spark {
  flex: none;
  display: block;
}
.fb-obs-spark[data-tone='primary'] { color: var(--dsw-alias-state-business-primary); }
.fb-obs-spark[data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
.fb-obs-spark[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.fb-obs-spark[data-tone='danger'] { color: var(--dsw-alias-state-error-primary); }
.fb-obs-mini-meter {
  flex: none;
  width: 68px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.fb-obs-mini-meter-track {
  width: 100%;
  height: 5px;
  display: flex;
  gap: 1.5px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--dsw-alias-bg-module-platform);
}
.fb-obs-mini-meter-seg {
  height: 100%;
  display: block;
}
.fb-obs-mini-meter-seg[data-kind='cache'] { background: var(--dsw-alias-state-success-primary); opacity: 0.85; }
.fb-obs-mini-meter-seg[data-kind='warn'] { background: var(--dsw-alias-state-warn-primary); opacity: 0.85; }
.fb-obs-mini-meter-seg[data-kind='primary'] { background: var(--dsw-alias-state-business-primary); opacity: 0.85; }
.fb-obs-mini-meter-seg[data-kind='error'] { background: var(--dsw-alias-state-error-primary); opacity: 0.85; }
.fb-obs-mini-meter-lbl {
  font-size: 10px;
  line-height: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-obs-list {
  display: flex;
  flex-direction: column;
}
.fb-obs-list-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 10px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-obs-list-item:first-child { padding-top: 2px; }
.fb-obs-list-item:last-child { padding-bottom: 0; border-bottom: none; }
.fb-obs-current-band {
  fill: var(--dsw-alias-bg-module-platform);
  opacity: 0.72;
}

.fb-obs-panel {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.fb-obs-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
  min-height: 26px;
}
.fb-obs-panel-head .fb-filter-tabs {
  gap: 4px;
}
.fb-obs-panel-head .fb-filter-tab {
  height: 24px;
  padding: 0 9px;
  border-radius: 12px;
  font-size: 12px;
  line-height: 18px;
  gap: 4px;
}
.fb-obs-panel-head .fb-tab-count {
  font-size: 11px;
}
.fb-obs-db-wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fb-obs-hud [data-warn] {
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
}
.fb-obs-db-split {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  align-items: start;
}
.fb-obs-db-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fb-obs-db-col[data-bordered] {
  padding-left: 20px;
  border-left: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-obs-db-col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 6px 4px;
}
.fb-obs-db-scale {
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-obs-db-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fb-obs-db-row {
  display: grid;
  grid-template-columns: minmax(120px, 1.4fr) minmax(80px, 1fr) 54px;
  align-items: center;
  gap: 12px;
  height: 30px;
  padding: 0 6px;
  border-radius: var(--dsw-radius-sm);
  transition: background 100ms ease;
}
.fb-obs-db-row[data-active] {
  background: var(--dsw-alias-bg-module-platform);
}
.fb-obs-db-name {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11.5px;
  line-height: 16px;
  overflow: hidden;
  white-space: nowrap;
}
.fb-obs-db-verb {
  flex: none;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-obs-db-target {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-db-track {
  position: relative;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  overflow: hidden;
}
.fb-obs-db-tail,
.fb-obs-db-core {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: 999px;
}
.fb-obs-db-tail { opacity: 0.3; }
.fb-obs-db-core { opacity: 0.92; }
.fb-obs-db-tail[data-kind='primary'],
.fb-obs-db-core[data-kind='primary'] {
  background: var(--dsw-alias-state-business-primary);
}
.fb-obs-db-tail[data-kind='warn'],
.fb-obs-db-core[data-kind='warn'] {
  background: var(--dsw-alias-state-warn-primary);
}
.fb-obs-db-tail[data-kind='error'],
.fb-obs-db-core[data-kind='error'] {
  background: var(--dsw-alias-state-error-primary);
}
.fb-obs-db-thresh {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--dsw-alias-state-error-primary);
  opacity: 0.5;
  z-index: 1;
}
.fb-obs-db-val {
  text-align: right;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.fb-obs-db-val[data-tone='warn'] {
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
}
.fb-obs-db-val[data-tone='error'] {
  color: var(--dsw-alias-state-error-primary);
}
.fb-obs-db-legend {
  padding-top: 2px;
}
.fb-obs-db-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
@media (max-width: 820px) {
  .fb-obs-db-split { grid-template-columns: 1fr; gap: 14px; }
  .fb-obs-db-col[data-bordered] { padding-left: 0; border-left: none; padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
}
.fb-obs-panel-title-wrap {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.fb-obs-panel-title {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-panel-sub {
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-obs-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: stretch;
}
.fb-obs-heat-split {
  display: grid;
  grid-template-columns: minmax(0, 1.42fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.fb-obs-heat-pane {
  min-width: 0;
}
.fb-obs-proactive-pane {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-left: 20px;
  border-left: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-obs-divider {
  height: 0.5px;
  background: var(--dsw-alias-border-l2);
}
.fb-obs-subhead {
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.fb-obs-muted {
  color: var(--dsw-alias-label-tertiary);
}
.fb-obs-empty-inline {
  padding: 20px 8px;
  text-align: center;
  font-size: 12.5px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-obs-healthy-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, transparent);
  font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
}

/* Charts & HUD */
.fb-obs-chart-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fb-obs-hud {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 14px;
  min-height: 26px;
  padding: 4px 10px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.fb-obs-hud strong {
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-svg {
  width: 100%;
  height: auto;
  display: block;
  overflow: visible;
}
.fb-obs-grid-line {
  stroke: var(--dsw-alias-border-l2);
  stroke-width: 0.75;
}
.fb-obs-crosshair {
  stroke: var(--dsw-alias-label-tertiary);
  stroke-width: 0.9;
  stroke-dasharray: 2 2;
}
.fb-obs-axis-text {
  fill: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code);
  font-size: 10px;
}
.fb-obs-fill-cache {
  fill: var(--dsw-alias-state-success-primary);
  opacity: 0.78;
  transition: opacity 100ms ease;
}
.fb-obs-fill-primary {
  fill: var(--dsw-alias-state-business-primary);
  opacity: 0.85;
  transition: opacity 100ms ease;
}
.fb-obs-fill-output {
  fill: var(--dsw-alias-state-warn-primary);
  opacity: 0.82;
  transition: opacity 100ms ease;
}
.fb-obs-fill-success {
  fill: var(--dsw-alias-state-success-primary);
  opacity: 0.78;
}
.fb-obs-fill-error {
  fill: var(--dsw-alias-state-error-primary);
  opacity: 0.85;
}
.fb-obs-fill-muted {
  fill: var(--dsw-alias-label-tertiary);
  opacity: 0.28;
}
.fb-obs-fill-cache[data-active],
.fb-obs-fill-primary[data-active],
.fb-obs-fill-output[data-active],
.fb-obs-fill-success[data-active],
.fb-obs-fill-muted[data-active] {
  opacity: 1;
}
.fb-obs-line-primary {
  stroke: var(--dsw-alias-state-business-primary);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.fb-obs-line-success {
  stroke: var(--dsw-alias-state-success-primary);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.fb-obs-line-warn {
  stroke: var(--dsw-alias-state-warn-primary);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.fb-obs-dot-primary { fill: var(--dsw-alias-state-business-primary); }
.fb-obs-dot-success { fill: var(--dsw-alias-state-success-primary); }
.fb-obs-dot-warn { fill: var(--dsw-alias-state-warn-primary); }

.fb-obs-legend {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-obs-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.fb-obs-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: none;
}
.fb-obs-dot[data-kind='cache'] { background: var(--dsw-alias-state-success-primary); }
.fb-obs-dot[data-kind='primary'] { background: var(--dsw-alias-state-business-primary); }
.fb-obs-dot[data-kind='output'] { background: var(--dsw-alias-state-warn-primary); }
.fb-obs-dot[data-kind='success'] { background: var(--dsw-alias-state-success-primary); }
.fb-obs-dot[data-kind='warn'] { background: var(--dsw-alias-state-warn-primary); }
.fb-obs-dot[data-kind='error'] { background: var(--dsw-alias-state-error-primary); }
.fb-obs-dot[data-kind='muted'] { background: var(--dsw-alias-label-tertiary); opacity: 0.55; }

/* Segmented bar */
.fb-obs-segbar-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.fb-obs-segbar {
  display: flex;
  height: 8px;
  gap: 2px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--dsw-alias-bg-module-platform);
}
.fb-obs-segbar-empty {
  width: 100%;
  background: var(--dsw-alias-bg-module-platform);
}
.fb-obs-segbar-seg {
  height: 100%;
  transition: width 200ms ease;
}
.fb-obs-segbar-seg[data-kind='cache'] { background: var(--dsw-alias-state-success-primary); opacity: 0.85; }
.fb-obs-segbar-seg[data-kind='primary'] { background: var(--dsw-alias-state-business-primary); opacity: 0.88; }
.fb-obs-segbar-seg[data-kind='output'] { background: var(--dsw-alias-state-warn-primary); opacity: 0.85; }
.fb-obs-segbar-seg[data-kind='warn'] { background: var(--dsw-alias-state-warn-primary); opacity: 0.85; }
.fb-obs-segbar-seg[data-kind='error'] { background: var(--dsw-alias-state-error-primary); opacity: 0.88; }
.fb-obs-segbar-seg[data-kind='muted'] { background: var(--dsw-alias-label-tertiary); opacity: 0.45; }
.fb-obs-segbar-legend {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 18px;
  font-size: 12px;
  line-height: 18px;
}
.fb-obs-segbar-legend[data-layout='list'] {
  grid-template-columns: minmax(0, 1fr);
  gap: 5px;
}
.fb-obs-segbar-legend[data-layout='row'] {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px 14px;
}
.fb-obs-segbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
}
.fb-obs-segbar-row .fb-obs-legend-item {
  min-width: 0;
}
.fb-obs-segbar-lbl {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-obs-segbar-val {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  flex: none;
  white-space: nowrap;
}
.fb-obs-segbar-val strong {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

/* Tables & horizontal bars */
.fb-obs-table-wrap {
  overflow-x: auto;
}
.fb-obs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  line-height: 18px;
}
.fb-obs-table th {
  padding: 4px 6px 8px;
  text-align: left;
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  white-space: nowrap;
}
.fb-obs-table td {
  padding: 8px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  vertical-align: middle;
}
.fb-obs-table tbody tr:last-child td {
  border-bottom: none;
}
.fb-obs-tr { text-align: right !important; }
.fb-obs-cell-stack {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  max-width: 340px;
}
.fb-obs-cell-stack[data-wide] {
  max-width: 460px;
}
.fb-obs-cell-main {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.fb-obs-cell-sub {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-obs-bot-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 240px;
}
.fb-obs-pill {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.fb-obs-pill[data-tone='good'] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent);
  color: var(--dsw-alias-state-success-primary);
}
.fb-obs-pill[data-tone='warn'] {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
}
.fb-obs-pill[data-tone='bad'] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 13%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.fb-obs-bar-num {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  min-width: 68px;
}
.fb-obs-mini-track {
  width: 100%;
  height: 4px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  overflow: hidden;
}
.fb-obs-mini-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary);
  opacity: 0.85;
}
.fb-obs-mini-fill[data-kind='error'] {
  background: var(--dsw-alias-state-error-primary);
}

/* Funnel & horizontal bars */
.fb-obs-funnel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fb-obs-funnel-row {
  display: grid;
  grid-template-columns: 124px minmax(0, 1fr) 44px;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.fb-obs-funnel-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-obs-funnel-bar {
  height: 7px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  overflow: hidden;
}
.fb-obs-funnel-fill {
  height: 100%;
  border-radius: 999px;
}
.fb-obs-funnel-fill[data-kind='cache'] { background: var(--dsw-alias-state-success-primary); opacity: 0.85; }
.fb-obs-funnel-fill[data-kind='primary'] { background: var(--dsw-alias-state-business-primary); opacity: 0.88; }
.fb-obs-funnel-fill[data-kind='output'] { background: var(--dsw-alias-state-warn-primary); opacity: 0.82; }
.fb-obs-funnel-fill[data-kind='error'] { background: var(--dsw-alias-state-error-primary); opacity: 0.88; }
.fb-obs-funnel-val {
  text-align: right;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-bars-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.fb-obs-hrow {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fb-obs-hrow-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-inline-code {
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-tertiary);
}

/* Listener rules observability panel */
.fb-obs-listener-segbar .fb-obs-segbar-legend[data-layout='row'] {
  grid-template-columns: repeat(auto-fit, minmax(176px, 1fr));
  gap: 6px 20px;
}
.fb-obs-listener-table th:nth-child(3),
.fb-obs-listener-table td:nth-child(3) {
  padding-left: 18px;
}
.fb-obs-listener-table th:nth-child(3) {
  min-width: 210px;
}
.fb-obs-listener-row {
  cursor: pointer;
  transition: background 110ms ease;
}
.fb-obs-listener-row:hover td,
.fb-obs-listener-row:focus-visible td {
  background: color-mix(in srgb, var(--dsw-alias-bg-module-platform) 55%, transparent);
}
.fb-obs-listener-row:focus-visible {
  outline: none;
}
.fb-obs-listener-row[data-expanded] td {
  border-bottom-color: transparent;
  background: color-mix(in srgb, var(--dsw-alias-bg-module-platform) 42%, transparent);
}
.fb-obs-listener-row[data-expanded] .fb-obs-rank-chevron {
  transform: rotate(90deg);
  color: var(--dsw-alias-label-primary);
}
.fb-obs-listener-ratio {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 184px;
}
.fb-obs-listener-bar {
  display: flex;
  flex: 1 1 92px;
  min-width: 72px;
  max-width: 168px;
  height: 6px;
  gap: 1.5px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--dsw-alias-bg-module-platform);
}
.fb-obs-listener-seg {
  height: 100%;
  display: block;
}
.fb-obs-listener-seg[data-kind='primary'] {
  background: var(--dsw-alias-state-business-primary);
  opacity: 0.88;
}
.fb-obs-listener-seg[data-kind='cache'] {
  background: var(--dsw-alias-state-success-primary);
  opacity: 0.82;
}
.fb-obs-listener-seg[data-kind='muted'] {
  background: var(--dsw-alias-label-tertiary);
  opacity: 0.45;
}
.fb-obs-listener-seg[data-kind='error'] {
  background: var(--dsw-alias-state-error-primary);
  opacity: 0.88;
}
.fb-obs-listener-ratio-meta {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.fb-obs-listener-end {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  white-space: nowrap;
}
.fb-obs-listener-detail-row td {
  padding: 0 0 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.fb-obs-listener-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px 12px;
  border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-bg-module-platform) 62%, transparent);
}
.fb-obs-listener-detail-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px 14px;
  font-size: 11.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-listener-detail-grid em {
  font-style: normal;
  margin-right: 4px;
}
.fb-obs-listener-lat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
}
.fb-obs-listener-lat-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.fb-obs-listener-lat-row {
  display: grid;
  grid-template-columns: minmax(150px, 230px) minmax(0, 1fr) 128px;
  align-items: center;
  gap: 12px;
}
.fb-obs-listener-lat-name {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.fb-obs-listener-lat-track {
  position: relative;
  height: 7px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  overflow: hidden;
}
.fb-obs-listener-lat-p95 {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent);
}
.fb-obs-listener-lat-p50 {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary);
  opacity: 0.9;
}
.fb-obs-listener-lat-val {
  text-align: right;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}
.fb-obs-listener-lat-val em {
  font-style: normal;
}
.fb-obs-reflection-bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.fb-obs-reflection-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
}
.fb-obs-reflection-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  font-size: 11.5px;
  line-height: 16px;
}
.fb-obs-reflection-title {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-reflection-summary {
  border: none;
  padding: 0;
  margin: 0;
  background: transparent;
  text-align: left;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.fb-obs-reflection-summary[data-expanded] {
  white-space: normal;
  overflow: visible;
  text-overflow: unset;
}
.fb-obs-reflection-summary:hover {
  color: var(--dsw-alias-label-primary);
}
@media (max-width: 900px) {
  .fb-obs-listener-detail-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .fb-obs-listener-lat-row {
    grid-template-columns: minmax(110px, 160px) minmax(0, 1fr) 112px;
  }
}

/* Latency histogram & percentile strip */
.fb-obs-percentile-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 8px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-percentile-strip em {
  font-style: normal;
  margin-right: 4px;
}
.fb-obs-hist {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  padding-top: 4px;
}
.fb-obs-hist-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.fb-obs-hist-val {
  height: 14px;
  font-size: 11px;
  line-height: 14px;
  color: var(--dsw-alias-label-secondary);
}
.fb-obs-hist-track {
  width: 100%;
  height: 82px;
  display: flex;
  align-items: flex-end;
  border-radius: 4px;
  background: var(--dsw-alias-bg-module-platform);
  overflow: hidden;
}
.fb-obs-hist-bar {
  width: 100%;
  border-radius: 3px 3px 0 0;
  background: var(--dsw-alias-state-business-primary);
  opacity: 0.82;
}
.fb-obs-hist-bar[data-slow] {
  background: var(--dsw-alias-state-warn-primary);
}
.fb-obs-hist-lbl {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.fb-obs-hist-pct {
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
}

/* Activity Heatmap (7x24 matrix) */
.fb-obs-heat-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fb-obs-heat-hud {
  min-height: 20px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-obs-heat-hud strong {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.fb-obs-heat-grid {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.fb-obs-heat-axis-row,
.fb-obs-heat-row {
  display: grid;
  grid-template-columns: 30px repeat(24, minmax(0, 1fr));
  align-items: center;
  gap: 3px;
}
.fb-obs-heat-hour {
  font-size: 9.5px;
  line-height: 12px;
  color: var(--dsw-alias-label-tertiary);
  overflow: visible;
  white-space: nowrap;
}
.fb-obs-heat-hour[data-end] {
  text-align: right;
}
.fb-obs-heat-day {
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-obs-heat-cell {
  height: clamp(12px, 1.35vw, 22px);
  min-height: 11px;
  width: 100%;
  padding: 0;
  border: none;
  border-radius: 2.5px;
  background: var(--dsw-alias-bg-module-platform);
  cursor: pointer;
  transition: transform 90ms ease, box-shadow 90ms ease;
}
.fb-obs-heat-cell[data-level='1'],
.fb-obs-heat-swatch[data-level='1'] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, var(--dsw-alias-bg-module-platform));
}
.fb-obs-heat-cell[data-level='2'],
.fb-obs-heat-swatch[data-level='2'] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 46%, var(--dsw-alias-bg-module-platform));
}
.fb-obs-heat-cell[data-level='3'],
.fb-obs-heat-swatch[data-level='3'] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 72%, var(--dsw-alias-bg-module-platform));
}
.fb-obs-heat-cell[data-level='4'],
.fb-obs-heat-swatch[data-level='4'] {
  background: var(--dsw-alias-state-business-primary);
}
.fb-obs-heat-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  font-size: 11px;
}
.fb-obs-heat-swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: var(--dsw-alias-bg-module-platform);
}

/* Micro KPIs, rankings, errors & storage table chips */
.fb-obs-micro-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.fb-obs-micro-grid[data-cols='2'] {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.fb-obs-micro-cell {
  padding: 9px 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.fb-obs-micro-lbl {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.fb-obs-micro-cell strong {
  font-size: 15px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-micro-cell > span:last-child {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-obs-rank-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.fb-obs-rank-item {
  border-radius: var(--dsw-radius-md);
  transition: background 110ms ease;
}
.fb-obs-rank-item[data-expanded] {
  background: var(--dsw-alias-bg-module-platform);
}
.fb-obs-rank-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: background 110ms ease, box-shadow 110ms ease;
}
.fb-obs-rank-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fb-obs-rank-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  min-width: 0;
}
.fb-obs-rank-title > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-obs-rank-meta {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-obs-rank-side {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  min-width: 64px;
  font-size: 12.5px;
  line-height: 17px;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-rank-side > span {
  font-size: 11px;
}
.fb-obs-rank-track {
  width: 58px;
}
.fb-obs-rank-chevron {
  flex: none;
  width: 14px;
  text-align: center;
  font-size: 14px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 130ms ease, color 130ms ease;
}
.fb-obs-rank-item[data-expanded] .fb-obs-rank-chevron {
  transform: rotate(90deg);
  color: var(--dsw-alias-label-secondary);
}
.fb-obs-rank-detail {
  padding: 8px 0 10px;
  margin: 0 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.fb-obs-rank-detail-grid {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px;
  font-size: 11.5px;
  line-height: 17px;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-rank-detail-grid em {
  font-style: normal;
  margin-right: 2px;
}
.fb-obs-rank-models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.fb-obs-rank-model-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l2);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-rank-model-chip em {
  font-style: normal;
}
.fb-obs-rank-more {
  margin-top: 4px;
  align-self: center;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background 110ms ease, color 110ms ease;
}
.fb-obs-rank-more:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.fb-obs-rank-more:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.fb-obs-kv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.fb-obs-kv-row [data-warn] {
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
}
.fb-obs-storage-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fb-obs-err-feed {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fb-obs-err-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  line-height: 18px;
}
.fb-obs-err-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
}
.fb-obs-table-chips {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.fb-obs-table-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 9px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}
.fb-obs-table-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-obs-table-chip strong {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
@media (hover: hover) {
  .fb-obs-window-btn:hover:not([aria-pressed='true']) {
    color: var(--dsw-alias-label-primary);
  }
  .fb-obs-rank-item:not([data-expanded]) .fb-obs-rank-row:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
  .fb-obs-heat-cell:hover {
    transform: scale(1.18);
    box-shadow: 0 0 0 1px var(--dsw-alias-label-secondary);
  }
}
.fb-obs-window-btn:focus-visible,
.fb-obs-rank-row:focus-visible,
.fb-obs-heat-cell:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
@media (prefers-reduced-motion: reduce) {
  .fb-obs-pulse-dot { animation: none; }
}
.fb-tier-panel { display: flex; flex-direction: column; gap: 10px; width: 100%; }
.fb-tier-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.fb-tier-prompt-row { width: 100%; }
.fb-tier-prompt-row > *, .fb-tier-prompt-row input { width: 100% !important; max-width: none !important; }
.fb-tier-empty { padding: 14px 4px; font-size: 12.5px; color: var(--dsw-alias-label-tertiary); text-align: center; border-top: 0.5px solid var(--dsw-alias-border-l2); border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.fb-tier-list { display: flex; flex-direction: column; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.fb-tier-row { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.fb-tier-row-top { display: flex; align-items: center; gap: 8px; width: 100%; }
.fb-tier-row-bottom { display: flex; align-items: center; gap: 8px; width: 100%; padding-right: 36px; box-sizing: border-box; }
.fb-tier-field { min-width: 0; }
.fb-tier-field-rt { flex: 1 1 130px; }
.fb-tier-field-prof { flex: 1 1 120px; }
.fb-tier-field-model { flex: 1.8 1 200px; }
.fb-tier-field-effort { flex: 1 1 120px; }
.fb-tier-weight { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; margin-left: auto; }
.fb-tier-weight-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.fb-tier-weight-input { width: 56px; height: 32px; padding: 0 8px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; outline: none; }
.fb-tier-weight-input:focus { border-color: var(--dsw-alias-state-business-primary); }
.fb-tier-share { min-width: 34px; font-size: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; text-align: right; }
.fb-tier-remove { flex: 0 0 auto; }

@media (max-width: 960px) {
  .fb-obs-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fb-obs-grid-2,
  .fb-obs-heat-split { grid-template-columns: 1fr; }
  .fb-obs-proactive-pane {
    padding-left: 0;
    padding-top: 14px;
    border-left: none;
    border-top: 0.5px solid var(--dsw-alias-border-l2);
  }
}
@media (max-width: 720px) {
  .fb-obs-kpi-grid { grid-template-columns: 1fr; }
  .fb-obs-micro-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fb-obs-segbar-legend,
  .fb-obs-segbar-legend[data-layout='row'] { grid-template-columns: 1fr; }
}
@media (hover: hover) {
  .fb-select:hover:not(:disabled), .fb-nav-cell:hover:not([aria-current='page']), .fb-icon-btn:hover, .fb-dialog-back:hover, .fb-env-remove:hover, .fb-tag-chip button:hover, .fb-picker-item:hover:not(:disabled), .fb-op-app-item:hover:not(:disabled):not([data-selected]), .fb-link-btn:hover, .fb-inline-jump:hover, .fb-profile-new-btn:hover, .fb-collapse-toggle:hover, .fb-env-hint-btn:hover, .fb-dream-inline-link:hover, .fb-mem-facet-row:hover:not([aria-current='page']), .fb-mem-scope-leaf:hover:not([aria-current='page']), .fb-mem-mini-tag:hover:not([aria-pressed='true']), .fb-mem-branch-toggle:hover:not(:disabled), .fb-mem-search-clear:hover, .fb-mem-tool-btn:hover:not(:disabled), .fb-mem-paper-tag:hover, .fb-mem-foot-action:hover, .fb-mem-graph-iconbtn:hover:not(:disabled), .fb-mem-graph-group-row:hover, .fb-mem-graph-link-row:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
  .fb-mem-foot-action:hover { color: var(--dsw-alias-state-business-primary); }
  .fb-mem-note-card:hover:not([data-active]) { background: var(--dsw-alias-interactive-bg-hover); }
  .fb-mem-tool-btn[data-pinned]:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent); color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); }
}
.fb-select:focus-visible, .fb-icon-btn:focus-visible, .fb-dialog-back:focus-visible, .fb-env-remove:focus-visible, .fb-nav-cell:focus-visible, .fb-op-app-item:focus-visible, .fb-dream-inline-link:focus-visible, .fb-mem-facet-row:focus-visible, .fb-mem-scope-leaf:focus-visible, .fb-mem-mini-tag:focus-visible, .fb-mem-branch-toggle:focus-visible, .fb-mem-note-card:focus-visible, .fb-mem-tool-btn:focus-visible, .fb-mem-paper-tag:focus-visible, .fb-mem-foot-action:focus-visible, .fb-mem-graph-iconbtn:focus-visible, .fb-mem-graph-acc-head:focus-visible, .fb-mem-graph-group-row:focus-visible, .fb-mem-graph-link-row:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
@container (max-width: 859px) {
  .fb-mem-workspace { grid-template-columns: 164px 236px minmax(0, 1fr); }
  .fb-mem-paper { padding: 20px 20px 32px; }
}
@container (max-width: 679px) {
  .fb-mem-frame:has(.fb-mem-workspace) { height: auto; }
  .fb-mem-workspace { height: auto; grid-template-columns: minmax(0, 1fr); }
  .fb-mem-col-nav, .fb-mem-col-list { border-right: none; border-bottom: 0.5px solid var(--dsw-alias-border-l2); max-height: 260px; }
  .fb-mem-graph-stage[data-drawer] .fb-mem-graph-controls { transform: none; }
}
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
