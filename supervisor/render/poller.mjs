// Polls GET /agents and GET /agents/{id}/log (~2 Hz) and hands the renderer a model each time.
// Never throws: a failed /agents becomes an "unreachable" model, a failed /log just blanks that agent's lines.
import { MAX_TILES } from './theme.mjs';

const clock = () => new Date().toISOString().slice(11, 19) + 'Z';

/**
 * @param {{ harness: { getAgents(): Promise<any[]>, getLog(id: string, lines?: number): Promise<{lines: string[]}> },
 *           harnessUrl?: string, intervalMs?: number, logLines?: number,
 *           onModel: (model: object) => void, now?: () => string }} options
 */
export function createPoller({ harness, harnessUrl, intervalMs = 500, logLines = 10, onModel, now = clock }) {
  let mode = 'grid';
  let focusId = null;
  let agents = [];
  let logs = {};
  let status = 'ok';
  let lastSeen = null;
  let busy = false;
  let timer = null;

  const model = () => ({ mode, focusId, agents, logs, harness: status, harnessUrl, lastSeen });
  const emit = () => { try { onModel(model()); } catch { /* a bad consumer must not stop polling */ } };

  async function tick() {
    if (busy) return; // the previous poll is still in flight
    busy = true;
    try {
      const list = await harness.getAgents();
      const wanted = list.slice(0, MAX_TILES);
      const focused = list.find(a => a.id === focusId);
      if (focused && !wanted.includes(focused)) wanted.push(focused);
      const entries = await Promise.all(wanted.map(async a => {
        try { return [a.id, (await harness.getLog(a.id, logLines)).lines ?? []]; } catch { return [a.id, []]; }
      }));
      agents = list;
      logs = Object.fromEntries(entries);
      status = 'ok';
      lastSeen = now();
    } catch {
      status = 'unreachable'; // keep the last good agents and logs; lastSeen says when they were fresh
    } finally {
      busy = false;
    }
    emit();
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      tick();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    /** setMode('grid') or setMode('focus', 'agent-2'); re-emits at once rather than waiting for the next poll. */
    setMode(next, id = null) {
      mode = next === 'focus' && id ? 'focus' : 'grid';
      focusId = mode === 'focus' ? id : null;
      emit();
    },
    get model() { return model(); },
  };
}
