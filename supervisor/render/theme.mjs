// Sizes, colours and the state badge table. Text minimums come from AGENTS.md §5.5 / the M2 brief.
// The layout works in "logical" units: 1920×1080 landscape or 1080×1920 portrait. A smaller canvas (720p) scales it.
export const LANDSCAPE = { width: 1920, height: 1080 };
export const PORTRAIT = { width: 1080, height: 1920 };
export const WIDTH = LANDSCAPE.width;
export const HEIGHT = LANDSCAPE.height;
export const isPortrait = frame => frame.height > frame.width;
// Portrait only: FaceTime draws its own controls over the top and bottom of the picture, and a tall phone screen
// (about 9:19.5) crops the sides of a 1080-wide frame. Values are in logical px (1080×1920), so the 720p fallback
// scales them. Configurable with VIDEO_SAFE_TOP / VIDEO_SAFE_BOTTOM / VIDEO_SAFE_SIDE.
export const DEFAULT_SAFE = { top: 120, bottom: 260, side: 110 };
// The caller's self-view floats in a corner: keep text out of a box about its size in the two right-hand corners of
// the safe area (FaceTime's default side). CORNER_GAP is the breathing room between text and that box.
export const CORNER = { width: 300, height: 360 };
export const CORNER_GAP = 16;
export const orientationOf = (width, height) => (height > width ? 'portrait' : 'landscape');
export const frameFor = orientation => (orientation === 'portrait' ? PORTRAIT : LANDSCAPE);
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
export const FOCUS = { name: 72, badge: 48, task: 44, reason: 44, log: 36, logLines: 10, pad: 48, stripe: 16, margin: 40, taskLines: 1, reasonLines: 2 };
// Portrait: full-width stacked tiles with room for bigger text, and a narrow focus view that wraps instead of truncating.
export const GRID_PORTRAIT = { name: 56, badge: 36, task: 36, log: 32, logLines: 5, pad: 32, gap: 24, stripe: 8, margin: 40 };
export const FOCUS_PORTRAIT = { name: 88, badge: 56, task: 48, reason: 42, log: 38, logLines: 10, pad: 48, stripe: 16, margin: 40, taskLines: 3, reasonLines: 6 };
export const MAX_TILES = 3;
