// Pure layout: model → drawing ops. No canvas here; `measure(text, fontPx, bold)` is injected, so tests can
// assert that nothing overflows without reading pixels. Truncation happens here, not at paint time.
//
// model = { agents: AgentState[], logs: { [agentId]: string[] }, mode: 'grid'|'focus', focusId?: string,
//           harness: 'ok'|'unreachable', harnessUrl?: string, lastSeen?: string }
// frame = { width, height, safe?: { top, bottom, side } } in logical units: LANDSCAPE (default) or PORTRAIT from theme.mjs.
//         Portrait keeps everything inside the safe area (top, bottom and sides) and text out of the right-hand
//         corners of it (self-view).
// ops   = { type:'rect', x, y, w, h, fill, radius? } | { type:'text', text, x, y, fontPx, bold, fill, maxWidth }
import { COLORS, CORNER, CORNER_GAP, DEFAULT_SAFE, FOCUS, FOCUS_PORTRAIT, GRID, GRID_PORTRAIT, isPortrait, LANDSCAPE, MAX_TILES, stateStyle } from './theme.mjs';

const ELLIPSIS = '…';

/** Longest prefix of text that fits maxWidth, with an ellipsis when cut. Never overflows (empty if nothing fits). */
export function fitText(text, maxWidth, fontPx, measure, bold = false) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (measure(s, fontPx, bold) <= maxWidth) return s;
  let lo = 0, hi = s.length; // largest n with prefix(n) + … fitting
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(s.slice(0, mid).trimEnd() + ELLIPSIS, fontPx, bold) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  const out = s.slice(0, lo).trimEnd() + ELLIPSIS;
  return measure(out, fontPx, bold) <= maxWidth ? out : '';
}

/**
 * Word-wrap into at most maxLines lines; if text is left over, the last line ends in an ellipsis.
 * maxWidth is a number, or a function of the line index when lines have different room (near a corner).
 */
export function wrapText(text, maxWidth, fontPx, maxLines, measure, bold = false) {
  const widthOf = i => (typeof maxWidth === 'function' ? maxWidth(i) : maxWidth);
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, fontPx, bold) <= widthOf(lines.length)) { line = next; continue; }
    if (line) lines.push(line);
    line = fitText(word, widthOf(lines.length), fontPx, measure, bold); // a single word wider than the line is cut
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  // The remainder spans more than one line, so it overflows this one and fitText adds the ellipsis.
  const last = fitText(lines.slice(maxLines - 1).join(' '), widthOf(maxLines - 1), fontPx, measure, bold);
  return [...lines.slice(0, maxLines - 1), last];
}

/** The safe-area insets for a frame: portrait only (landscape has none). */
export function safeOf(frame) {
  if (!isPortrait(frame)) return { top: 0, bottom: 0, side: 0 };
  return {
    top: frame.safe?.top ?? DEFAULT_SAFE.top,
    bottom: frame.safe?.bottom ?? DEFAULT_SAFE.bottom,
    side: frame.safe?.side ?? DEFAULT_SAFE.side,
  };
}

/** Where the caller's self-view may sit: the two right-hand corners of the safe area (portrait only). */
export function cornerZones(frame) {
  if (!isPortrait(frame)) return [];
  const s = safeOf(frame);
  const x = frame.width - s.side - CORNER.width;
  return [
    { x, y: s.top, w: CORNER.width, h: CORNER.height },
    { x, y: frame.height - s.bottom - CORNER.height, w: CORNER.width, h: CORNER.height },
  ];
}

const ROW_HEIGHT = 1.25; // a row of text counts as this many font-heights tall when checking for a corner

/** Widest a row of text starting at (x, y) may be, with full as the limit, without reaching into a corner zone. */
export function rowWidth(frame, x, y, fontPx, full) {
  let w = full;
  for (const z of cornerZones(frame)) {
    if (y < z.y + z.h && y + fontPx * ROW_HEIGHT > z.y) w = Math.min(w, z.x - CORNER_GAP - x);
  }
  return Math.max(w, 0);
}

/** A text op whose string is already fitted with the real measure. */
function textOp(measure, t, x, y, fontPx, fill, maxWidth, bold = false) {
  return { type: 'text', text: fitText(t, maxWidth, fontPx, measure, bold), x, y, fontPx, bold, fill, maxWidth };
}

/** State pill: rounded rect + one text op "<glyph> <LABEL>". Returns ops and the pill width. */
function badge(measure, state, x, y, fontPx) {
  const s = stateStyle(state);
  const label = `${s.glyph} ${s.label}`;
  const padX = Math.round(fontPx * 0.5);
  const h = Math.round(fontPx * 1.5);
  const w = Math.ceil(measure(label, fontPx, true)) + padX * 2;
  return {
    w, h,
    ops: [
      { type: 'rect', x, y, w, h, fill: s.bg, radius: h / 2 },
      { type: 'text', text: label, x: x + padX, y: y + Math.round((h - fontPx) / 2) + 2, fontPx, bold: true, fill: s.fg, maxWidth: w - padX * 2 },
    ],
  };
}

const background = (fill, frame) => ({ type: 'rect', x: 0, y: 0, w: frame.width, h: frame.height, fill });

/** Which view actually gets drawn: focus falls back to grid when the agent is not there. */
export function effectiveView(model) {
  if (model.harness === 'unreachable') return 'unreachable';
  if (model.mode === 'focus' && model.agents?.some(a => a.id === model.focusId)) return 'focus';
  return 'grid';
}

export function layout(model, measure, frame = LANDSCAPE) {
  const view = effectiveView(model);
  if (view === 'unreachable') return layoutUnreachable(model, measure, frame);
  return view === 'focus' ? layoutFocus(model, measure, frame) : layoutGrid(model, measure, frame);
}

export function layoutGrid(model, measure, frame = LANDSCAPE) {
  const portrait = isPortrait(frame);
  const T = portrait ? GRID_PORTRAIT : GRID;
  const safe = safeOf(frame);
  // Everything, panels included, stays inside the margins and (portrait) the safe area.
  const top = Math.max(T.margin, safe.top);
  const bottom = frame.height - Math.max(T.margin, safe.bottom);
  const left = Math.max(T.margin, safe.side); // landscape: safe.side is 0, so this is the plain margin
  const agents = (model.agents ?? []).slice(0, MAX_TILES);
  const ops = [background(COLORS.bg, frame)];
  if (!agents.length) {
    const w = rowWidth(frame, left, top, T.name, frame.width - 2 * left);
    ops.push(textOp(measure, 'No agents', left, top, T.name, COLORS.dim, w, true));
    return ops;
  }
  const n = agents.length;
  // Landscape: tiles side by side, sharing the width. Portrait: stacked, full width, each sized as if there were
  // MAX_TILES so positions do not jump when an agent appears or goes away.
  const tileW = portrait ? frame.width - 2 * left : Math.floor((frame.width - 2 * left - T.gap * (n - 1)) / n);
  const tileH = portrait ? Math.floor((bottom - top - T.gap * (MAX_TILES - 1)) / MAX_TILES) : bottom - top;
  agents.forEach((a, i) => {
    const x = portrait ? left : left + i * (tileW + T.gap);
    const y = portrait ? top + i * (tileH + T.gap) : top;
    const inner = tileW - T.stripe - 2 * T.pad;
    const tx = x + T.stripe + T.pad;
    const text = (t, ty, px, fill, bold = false) => textOp(measure, t, tx, ty, px, fill, rowWidth(frame, tx, ty, px, inner), bold);
    ops.push({ type: 'rect', x, y, w: tileW, h: tileH, fill: COLORS.panel, radius: 16 });
    ops.push({ type: 'rect', x, y, w: T.stripe, h: tileH, fill: a.color || COLORS.dim });
    let cy = y + T.pad;
    ops.push(text(a.name, cy, T.name, COLORS.text, true));
    cy += Math.round(T.name * 1.3);
    const b = badge(measure, a.state, tx, cy, T.badge);
    ops.push(...b.ops);
    cy += b.h + 20;
    ops.push(text(a.task ?? 'No task', cy, T.task, a.task ? COLORS.text : COLORS.dim));
    cy += Math.round(T.task * 1.5) + 12;
    const lh = Math.round(T.log * 1.45);
    // As many of the latest log lines as fit in the tile: a short (safe-area) tile drops a line.
    const room = Math.max(0, Math.floor((y + tileH - T.pad - cy) / lh));
    const lines = (model.logs?.[a.id] ?? []).slice(-Math.min(T.logLines, room));
    for (const line of lines) {
      ops.push(text(line, cy, T.log, COLORS.dim));
      cy += lh;
    }
  });
  return ops;
}

export function layoutFocus(model, measure, frame = LANDSCAPE) {
  const portrait = isPortrait(frame);
  const T = portrait ? FOCUS_PORTRAIT : FOCUS;
  const safe = safeOf(frame);
  const a = model.agents.find(x => x.id === model.focusId);
  const ops = [background(COLORS.bg, frame)];
  const stripeTop = portrait ? safe.top : 0;
  const limit = portrait ? frame.height - safe.bottom : frame.height - T.pad; // nothing is drawn below this
  const left = safe.side; // 0 in landscape
  ops.push({ type: 'rect', x: left, y: stripeTop, w: T.stripe, h: (portrait ? limit : frame.height) - stripeTop, fill: a.color || COLORS.dim });
  const x = left + T.stripe + T.pad;
  const inner = frame.width - safe.side - x - T.pad;
  let y = portrait ? safe.top + 24 : T.pad;
  const b = badge(measure, a.state, 0, y, T.badge); // measured first: landscape puts the name beside it
  if (portrait) {
    // narrow frame: name, then the badge under it
    ops.push(textOp(measure, a.name, x, y, T.name, COLORS.text, rowWidth(frame, x, y, T.name, inner), true));
    y += Math.round(T.name * 1.25);
    ops.push(...badge(measure, a.state, x, y, T.badge).ops);
    y += b.h + 24;
  } else {
    ops.push(textOp(measure, a.name, x, y, T.name, COLORS.text, inner - b.w - 32, true));
    ops.push(...badge(measure, a.state, frame.width - safe.side - T.pad - b.w, y, T.badge).ops);
    y += b.h + 20;
  }
  const taskStep = Math.round(T.task * 1.4);
  const taskY = y;
  const taskLines = a.task
    ? wrapText(a.task, i => rowWidth(frame, x, taskY + i * taskStep, T.task, inner), T.task, T.taskLines, measure)
    : ['No task'];
  for (const line of taskLines) {
    ops.push({ type: 'text', text: line, x, y, fontPx: T.task, bold: false, fill: a.task ? COLORS.text : COLORS.dim, maxWidth: rowWidth(frame, x, y, T.task, inner) });
    y += taskStep;
  }
  y += 16;
  if (a.state === 'stuck' && a.stuck_reason) {
    const lh = Math.round(T.reason * 1.25);
    const boxY = y;
    const lines = wrapText(`BLOCKED: ${a.stuck_reason}`, i => rowWidth(frame, x + 24, boxY + 22 + i * lh, T.reason, inner - 48), T.reason, T.reasonLines, measure, true);
    const boxH = lines.length * lh + 32;
    ops.push({ type: 'rect', x, y, w: inner, h: boxH, fill: COLORS.warn, radius: 12 });
    lines.forEach((l, i) => ops.push({ type: 'text', text: l, x: x + 24, y: y + 22 + i * lh, fontPx: T.reason, bold: true, fill: COLORS.warnText, maxWidth: rowWidth(frame, x + 24, y + 22 + i * lh, T.reason, inner - 48) }));
    y += boxH + 24;
  }
  const lh = Math.round(T.log * 1.4);
  const room = Math.max(0, Math.floor((limit - y) / lh));
  const lines = (model.logs?.[a.id] ?? []).slice(-Math.min(T.logLines, room));
  for (const line of lines) {
    ops.push(textOp(measure, line, x, y, T.log, COLORS.dim, rowWidth(frame, x, y, T.log, inner)));
    y += lh;
  }
  return ops;
}

export function layoutUnreachable(model, measure, frame = LANDSCAPE) {
  const portrait = isPortrait(frame);
  const x = portrait ? Math.max(64, safeOf(frame).side) : 96;
  const w = frame.width - 2 * x;
  const ops = [background('#2a0a0a', frame)];
  const headFont = portrait ? 88 : 96;
  const headStep = Math.round(headFont * 1.25);
  let y = portrait ? 520 : 300;
  const headY = y;
  for (const [i, line] of wrapText('! HARNESS UNREACHABLE', i => rowWidth(frame, x, headY + i * headStep, headFont, w), headFont, 2, measure, true).entries()) {
    ops.push({ type: 'text', text: line, x, y, fontPx: headFont, bold: true, fill: '#ffffff', maxWidth: rowWidth(frame, x, y, headFont, w) });
    y += headStep;
  }
  y += 24;
  for (const line of [`Cannot reach ${model.harnessUrl ?? 'the harness'}`, 'Retrying…', model.lastSeen ? `Last data: ${model.lastSeen}` : 'No data received yet']) {
    ops.push(textOp(measure, line, x, y, 44, '#ffd0d0', rowWidth(frame, x, y, 44, w)));
    y += 80;
  }
  return ops;
}

/** Stable string over exactly what gets drawn: equal keys ⇒ identical frames. */
export function modelKey(model) {
  const view = effectiveView(model);
  if (view === 'unreachable') return JSON.stringify({ view, url: model.harnessUrl ?? null, lastSeen: model.lastSeen ?? null });
  const agents = (model.agents ?? []).map(a => ({ id: a.id, name: a.name, color: a.color, state: a.state, task: a.task ?? null, reason: a.state === 'stuck' ? a.stuck_reason ?? null : null }));
  const shown = view === 'focus' ? agents.filter(a => a.id === model.focusId) : agents.slice(0, MAX_TILES);
  const logs = Object.fromEntries(shown.map(a => [a.id, (model.logs?.[a.id] ?? []).slice(-FOCUS.logLines)]));
  return JSON.stringify({ view, focusId: view === 'focus' ? model.focusId : null, agents: shown, logs });
}
