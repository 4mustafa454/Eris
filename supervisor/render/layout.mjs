// Pure layout: model → drawing ops. No canvas here; `measure(text, fontPx, bold)` is injected, so tests can
// assert that nothing overflows without reading pixels. Truncation happens here, not at paint time.
//
// model = { agents: AgentState[], logs: { [agentId]: string[] }, mode: 'grid'|'focus', focusId?: string,
//           harness: 'ok'|'unreachable', harnessUrl?: string, lastSeen?: string }
// frame = { width, height } in logical units: LANDSCAPE (default) or PORTRAIT from theme.mjs
// ops   = { type:'rect', x, y, w, h, fill, radius? } | { type:'text', text, x, y, fontPx, bold, fill, maxWidth }
import { COLORS, FOCUS, FOCUS_PORTRAIT, GRID, GRID_PORTRAIT, isPortrait, LANDSCAPE, MAX_TILES, stateStyle } from './theme.mjs';

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

/** Word-wrap into at most maxLines lines; if text is left over, the last line ends in an ellipsis. */
export function wrapText(text, maxWidth, fontPx, maxLines, measure, bold = false) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, fontPx, bold) <= maxWidth) { line = next; continue; }
    if (line) lines.push(line);
    line = fitText(word, maxWidth, fontPx, measure, bold); // a single word wider than the line is cut
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  // The remainder spans more than one line, so it overflows this one and fitText adds the ellipsis.
  const last = fitText(lines.slice(maxLines - 1).join(' '), maxWidth, fontPx, measure, bold);
  return [...lines.slice(0, maxLines - 1), last];
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
  const agents = (model.agents ?? []).slice(0, MAX_TILES);
  const ops = [background(COLORS.bg, frame)];
  if (!agents.length) {
    ops.push(textOp(measure, 'No agents', T.margin, T.margin, T.name, COLORS.dim, frame.width - 2 * T.margin, true));
    return ops;
  }
  const n = agents.length;
  // Landscape: tiles side by side, sharing the width. Portrait: stacked, full width, each sized as if there were
  // MAX_TILES so positions do not jump when an agent appears or goes away.
  const tileW = portrait ? frame.width - 2 * T.margin : Math.floor((frame.width - 2 * T.margin - T.gap * (n - 1)) / n);
  const tileH = portrait
    ? Math.floor((frame.height - 2 * T.margin - T.gap * (MAX_TILES - 1)) / MAX_TILES)
    : frame.height - 2 * T.margin;
  agents.forEach((a, i) => {
    const x = portrait ? T.margin : T.margin + i * (tileW + T.gap);
    const y = portrait ? T.margin + i * (tileH + T.gap) : T.margin;
    const inner = tileW - T.stripe - 2 * T.pad;
    const tx = x + T.stripe + T.pad;
    ops.push({ type: 'rect', x, y, w: tileW, h: tileH, fill: COLORS.panel, radius: 16 });
    ops.push({ type: 'rect', x, y, w: T.stripe, h: tileH, fill: a.color || COLORS.dim });
    let cy = y + T.pad;
    ops.push(textOp(measure, a.name, tx, cy, T.name, COLORS.text, inner, true));
    cy += Math.round(T.name * 1.3);
    const b = badge(measure, a.state, tx, cy, T.badge);
    ops.push(...b.ops);
    cy += b.h + 20;
    ops.push(textOp(measure, a.task ?? 'No task', tx, cy, T.task, a.task ? COLORS.text : COLORS.dim, inner));
    cy += Math.round(T.task * 1.5) + 12;
    const lh = Math.round(T.log * 1.45);
    const room = Math.max(0, Math.floor((y + tileH - T.pad - cy) / lh));
    const lines = (model.logs?.[a.id] ?? []).slice(-Math.min(T.logLines, room));
    for (const line of lines) {
      ops.push(textOp(measure, line, tx, cy, T.log, COLORS.dim, inner));
      cy += lh;
    }
  });
  return ops;
}

export function layoutFocus(model, measure, frame = LANDSCAPE) {
  const portrait = isPortrait(frame);
  const T = portrait ? FOCUS_PORTRAIT : FOCUS;
  const a = model.agents.find(x => x.id === model.focusId);
  const ops = [background(COLORS.bg, frame)];
  ops.push({ type: 'rect', x: 0, y: 0, w: T.stripe, h: frame.height, fill: a.color || COLORS.dim });
  const x = T.stripe + T.pad;
  const inner = frame.width - x - T.pad;
  let y = T.pad;
  const b = badge(measure, a.state, 0, y, T.badge); // measured first: landscape puts the name beside it
  if (portrait) {
    // narrow frame: name, then the badge under it
    ops.push(textOp(measure, a.name, x, y, T.name, COLORS.text, inner, true));
    y += Math.round(T.name * 1.25);
    ops.push(...badge(measure, a.state, x, y, T.badge).ops);
    y += b.h + 24;
  } else {
    ops.push(textOp(measure, a.name, x, y, T.name, COLORS.text, inner - b.w - 32, true));
    ops.push(...badge(measure, a.state, frame.width - T.pad - b.w, y, T.badge).ops);
    y += b.h + 20;
  }
  const taskLines = a.task ? wrapText(a.task, inner, T.task, T.taskLines, measure) : ['No task'];
  const taskStep = Math.round(T.task * 1.4);
  for (const line of taskLines) {
    ops.push({ type: 'text', text: line, x, y, fontPx: T.task, bold: false, fill: a.task ? COLORS.text : COLORS.dim, maxWidth: inner });
    y += taskStep;
  }
  y += 16;
  if (a.state === 'stuck' && a.stuck_reason) {
    const lines = wrapText(`BLOCKED: ${a.stuck_reason}`, inner - 48, T.reason, T.reasonLines, measure, true);
    const lh = Math.round(T.reason * 1.25);
    const boxH = lines.length * lh + 32;
    ops.push({ type: 'rect', x, y, w: inner, h: boxH, fill: COLORS.warn, radius: 12 });
    lines.forEach((l, i) => ops.push({ type: 'text', text: l, x: x + 24, y: y + 22 + i * lh, fontPx: T.reason, bold: true, fill: COLORS.warnText, maxWidth: inner - 48 }));
    y += boxH + 24;
  }
  const lh = Math.round(T.log * 1.4);
  const room = Math.max(0, Math.floor((frame.height - T.pad - y) / lh));
  const lines = (model.logs?.[a.id] ?? []).slice(-Math.min(T.logLines, room));
  for (const line of lines) {
    ops.push(textOp(measure, line, x, y, T.log, COLORS.dim, inner));
    y += lh;
  }
  return ops;
}

export function layoutUnreachable(model, measure, frame = LANDSCAPE) {
  const portrait = isPortrait(frame);
  const x = portrait ? 64 : 96;
  const w = frame.width - 2 * x;
  const ops = [background('#2a0a0a', frame)];
  const headFont = portrait ? 88 : 96;
  let y = portrait ? 520 : 300;
  for (const line of wrapText('! HARNESS UNREACHABLE', w, headFont, 2, measure, true)) {
    ops.push({ type: 'text', text: line, x, y, fontPx: headFont, bold: true, fill: '#ffffff', maxWidth: w });
    y += Math.round(headFont * 1.25);
  }
  y += 24;
  for (const line of [`Cannot reach ${model.harnessUrl ?? 'the harness'}`, 'Retrying…', model.lastSeen ? `Last data: ${model.lastSeen}` : 'No data received yet']) {
    ops.push(textOp(measure, line, x, y, 44, '#ffd0d0', w));
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
