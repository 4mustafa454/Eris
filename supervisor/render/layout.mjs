// Pure layout: model → drawing ops. No canvas here; `measure(text, fontPx, bold)` is injected, so tests can
// assert that nothing overflows without reading pixels. Truncation happens here, not at paint time.
//
// model = { agents: AgentState[], logs: { [agentId]: string[] }, mode: 'grid'|'focus', focusId?: string,
//           harness: 'ok'|'unreachable', harnessUrl?: string, lastSeen?: string }
// ops   = { type:'rect', x, y, w, h, fill, radius? } | { type:'text', text, x, y, fontPx, bold, fill, maxWidth }
import { COLORS, FOCUS, GRID, HEIGHT, MAX_TILES, stateStyle, WIDTH } from './theme.mjs';

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
      { type: 'text', text: label, x: x + padX, y: y + Math.round((h - fontPx) / 2) - 2, fontPx, bold: true, fill: s.fg, maxWidth: w - padX * 2 },
    ],
  };
}

const background = fill => ({ type: 'rect', x: 0, y: 0, w: WIDTH, h: HEIGHT, fill });

/** Which view actually gets drawn: focus falls back to grid when the agent is not there. */
export function effectiveView(model) {
  if (model.harness === 'unreachable') return 'unreachable';
  if (model.mode === 'focus' && model.agents?.some(a => a.id === model.focusId)) return 'focus';
  return 'grid';
}

export function layout(model, measure) {
  const view = effectiveView(model);
  if (view === 'unreachable') return layoutUnreachable(model, measure);
  return view === 'focus' ? layoutFocus(model, measure) : layoutGrid(model, measure);
}

export function layoutGrid(model, measure) {
  const T = GRID;
  const agents = (model.agents ?? []).slice(0, MAX_TILES);
  const ops = [background(COLORS.bg)];
  if (!agents.length) {
    ops.push(textOp(measure, 'No agents', T.margin, T.margin, T.name, COLORS.dim, WIDTH - 2 * T.margin, true));
    return ops;
  }
  const n = agents.length;
  const tileW = Math.floor((WIDTH - 2 * T.margin - T.gap * (n - 1)) / n);
  const tileH = HEIGHT - 2 * T.margin;
  agents.forEach((a, i) => {
    const x = T.margin + i * (tileW + T.gap);
    const y = T.margin;
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
    const lines = (model.logs?.[a.id] ?? []).slice(-T.logLines);
    for (const line of lines) {
      ops.push(textOp(measure, line, tx, cy, T.log, COLORS.dim, inner));
      cy += Math.round(T.log * 1.45);
    }
  });
  return ops;
}

export function layoutFocus(model, measure) {
  const T = FOCUS;
  const a = model.agents.find(x => x.id === model.focusId);
  const ops = [background(COLORS.bg)];
  ops.push({ type: 'rect', x: 0, y: 0, w: T.stripe, h: HEIGHT, fill: a.color || COLORS.dim });
  const x = T.stripe + T.pad;
  const inner = WIDTH - x - T.pad;
  let y = T.pad;
  const b = badge(measure, a.state, 0, y, T.badge); // measured first so the name can use the space left of it
  const nameW = inner - b.w - 32;
  ops.push(textOp(measure, a.name, x, y, T.name, COLORS.text, nameW, true));
  ops.push(...badge(measure, a.state, WIDTH - T.pad - b.w, y, T.badge).ops);
  y += b.h + 20;
  ops.push(textOp(measure, a.task ?? 'No task', x, y, T.task, a.task ? COLORS.text : COLORS.dim, inner));
  y += Math.round(T.task * 1.4) + 16;
  if (a.state === 'stuck' && a.stuck_reason) {
    const lines = wrapText(`BLOCKED: ${a.stuck_reason}`, inner - 48, T.reason, 2, measure, true);
    const lh = Math.round(T.reason * 1.25);
    const boxH = lines.length * lh + 32;
    ops.push({ type: 'rect', x, y, w: inner, h: boxH, fill: COLORS.warn, radius: 12 });
    lines.forEach((l, i) => ops.push({ type: 'text', text: l, x: x + 24, y: y + 16 + i * lh, fontPx: T.reason, bold: true, fill: COLORS.warnText, maxWidth: inner - 48 }));
    y += boxH + 24;
  }
  const lh = Math.round(T.log * 1.4);
  const room = Math.max(0, Math.floor((HEIGHT - T.pad - y) / lh));
  const lines = (model.logs?.[a.id] ?? []).slice(-Math.min(T.logLines, room));
  for (const line of lines) {
    ops.push(textOp(measure, line, x, y, T.log, COLORS.dim, inner));
    y += lh;
  }
  return ops;
}

export function layoutUnreachable(model, measure) {
  const x = 96, w = WIDTH - 2 * x;
  const ops = [background('#2a0a0a')];
  ops.push(textOp(measure, '! HARNESS UNREACHABLE', x, 300, 96, '#ffffff', w, true));
  ops.push(textOp(measure, `Cannot reach ${model.harnessUrl ?? 'the harness'}`, x, 440, 44, '#ffd0d0', w));
  ops.push(textOp(measure, 'Retrying…', x, 520, 44, '#ffd0d0', w));
  ops.push(textOp(measure, model.lastSeen ? `Last data: ${model.lastSeen}` : 'No data received yet', x, 600, 44, '#ffd0d0', w));
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
