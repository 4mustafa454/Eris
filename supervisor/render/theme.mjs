// Sizes, colours and the state badge table. Text minimums come from AGENTS.md §5.5 / the M2 brief.
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const MIN_GRID_PX = 28;
export const MIN_FOCUS_PX = 36;

export const FONT_FAMILY = 'ErisSans';
export const FONT_STACK = `"${FONT_FAMILY}", "DejaVu Sans", sans-serif`;

export const COLORS = { bg: '#111418', panel: '#1b2027', text: '#f2f4f7', dim: '#aab2bd', warn: '#ffcc66', warnText: '#2a1d00' };

/** State is shown by label AND glyph, never colour alone. */
export const STATES = {
  working: { label: 'WORKING', glyph: '●', bg: '#1f6f4a', fg: '#ffffff' },
  stuck: { label: 'STUCK', glyph: '!', bg: '#b3261e', fg: '#ffffff' },
  done: { label: 'DONE', glyph: '✓', bg: '#2d5fa8', fg: '#ffffff' },
  idle: { label: 'IDLE', glyph: '–', bg: '#4a525d', fg: '#ffffff' },
  error: { label: 'ERROR', glyph: '✕', bg: '#7a1f6b', fg: '#ffffff' },
  paused: { label: 'PAUSED', glyph: '‖', bg: '#8a6d00', fg: '#ffffff' },
};
export const UNKNOWN_STATE = { label: 'UNKNOWN', glyph: '?', bg: '#4a525d', fg: '#ffffff' };
export const stateStyle = state => STATES[state] ?? UNKNOWN_STATE;

export const GRID = { name: 44, badge: 32, task: 32, log: 28, logLines: 5, pad: 28, gap: 24, stripe: 8, margin: 40 };
export const FOCUS = { name: 72, badge: 48, task: 44, reason: 44, log: 36, logLines: 10, pad: 48, stripe: 16, margin: 40 };
export const MAX_TILES = 3;
