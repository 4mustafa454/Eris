// The first thing the caller hears. Spoken once, from a template: no LLM call, so it is ready well inside
// Chert's 10 seconds after bridge_ready (remote_audio_timeout). In M1 the recap is the team's CURRENT state;
// "what happened last call" arrives with session summaries in M4.
import { greetOnBridgeReady } from '../greet.mjs';

export const FALLBACK_GREETING = "Hi, it's Eris. I can't reach the team right now, but I'm here.";
const PREFIX = "Hi, it's Eris.";
const MAX_CLAUSES = 2;
const MAX_REASON_CHARS = 80;

/** Callers from the Chert Mac join as chert-bridge-<call id>. */
export const isBridgeCaller = identity => typeof identity === 'string' && identity.startsWith('chert-bridge-');

/** Shortens at a word boundary, for speech. */
const shorten = (text, max) =>
  text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, '').replace(/[\s.,;:!?-]+$/, '');
const sentence = clause => (/[.?!]$/.test(clause) ? clause : `${clause}.`);
const approvalWords = action => (action === 'git_push' ? 'push' : String(action).replace(/_/g, ' '));

/**
 * @param {object | null | undefined} context a GET /context response; null/undefined → fallback text
 * @returns {string} one or two spoken sentences: stuck agents and approvals first, then work in progress
 */
export function buildGreeting(context) {
  if (!context) return FALLBACK_GREETING;
  const agents = context.agents ?? [];
  const names = new Map(agents.map(a => [a.id, a.name]));
  const attention = [];
  const working = [];
  const finished = [];
  const paused = [];

  for (const a of agents) {
    const task = a.task ? ` "${a.task}"` : '';
    if (a.state === 'stuck') {
      attention.push(`${a.name} is stuck${a.stuck_reason ? `: ${shorten(a.stuck_reason, MAX_REASON_CHARS)}` : ''}`);
    } else if (a.state === 'error') {
      attention.push(`${a.name} hit an error`);
    } else if (a.state === 'working') {
      working.push(a.task ? `${a.name} is working on${task}` : `${a.name} is working`);
    } else if (a.state === 'done') {
      finished.push(a.task ? `${a.name} finished${task}` : `${a.name} is done`);
    } else if (a.state === 'paused') {
      paused.push(`${a.name} is paused`);
    }
  }
  for (const ap of context.pending_approvals ?? []) {
    const who = names.get(ap.agent_id) ?? 'An agent';
    attention.push(`${who} wants to ${approvalWords(ap.action)} and needs your approval`);
  }

  const lastCall = (context.recent_summaries ?? []).find(s => s.channel === 'facetime' && s.summary?.trim());
  const recap = lastCall ? [`Last call: ${shorten(lastCall.summary.trim().split(/(?<=[.!?])\s+/)[0], 120)}`] : [];
  const clauses = [...recap, ...attention, ...working, ...finished, ...paused];
  if (!clauses.length) return `${PREFIX} ${agents.length ? 'All agents are idle.' : 'No agents are running.'}`;
  const shown = clauses.slice(0, MAX_CLAUSES).map(sentence).join(' ');
  return `${PREFIX} ${shown}${clauses.length > MAX_CLAUSES ? ' Ask me for the rest.' : ''}`;
}

/**
 * The greeting text, from fresh state when the harness answers quickly, else from the state loaded at the
 * start of the session, else the fallback. Never throws and never waits longer than timeoutMs.
 */
export async function resolveGreeting({ fetchContext, cached = null, timeoutMs = 1500 }) {
  let timer;
  let fresh = null;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
    fresh = await Promise.race([fetchContext(), timeout]);
  } catch { /* keep the cached state */ } finally { clearTimeout(timer); }
  return buildGreeting(fresh ?? cached);
}

/**
 * Greets exactly once, from whichever trigger fires first:
 *  - Chert's bridge_ready room signal (the real one; also catches a signal that is already there), or
 *  - greetOnJoin, a development fallback for Agent Console, which never sends bridge_ready. It is
 *    ignored for chert-bridge-* callers, so it can never fire on a real FaceTime call.
 * Returns a function that stops waiting for the signal.
 *
 * @param {{ room: any, callerIdentity?: string, greetOnJoin?: boolean,
 *           greet: () => unknown, onError?: (error: unknown) => void }} options
 */
export function armGreeting({ room, callerIdentity, greetOnJoin = false, greet, onError = () => {} }) {
  let greeted = false;
  const once = () => {
    if (greeted) return;
    greeted = true;
    try {
      Promise.resolve(greet()).catch(onError);
    } catch (error) { onError(error); }
  };
  const stop = greetOnBridgeReady(room, once);
  if (greetOnJoin && !isBridgeCaller(callerIdentity)) once();
  return stop;
}
