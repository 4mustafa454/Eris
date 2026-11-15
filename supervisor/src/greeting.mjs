// The first thing the caller hears. Spoken once, from stored recap and live state, with no greeting-time LLM call.
import { greetOnBridgeReady } from '../greet.mjs';

export const FALLBACK_GREETING = "Hi, it's Eris. I can't reach the team right now, but I'm here.";
const PREFIX = "Hi, it's Eris.";
const MAX_REASON_CHARS = 80;

/** Callers from the Chert Mac join as chert-bridge-<call id>. */
export const isBridgeCaller = identity => typeof identity === 'string' && identity.startsWith('chert-bridge-');

/** Shortens at a word boundary, for speech. */
const shorten = (text, max) => {
  if (text.length <= max) return text;
  let head = text.slice(0, max);
  if (!/\s/.test(text[max]) && !/\s/.test(head.at(-1))) {
    const boundary = head.lastIndexOf(' ');
    head = boundary < 0 ? text.split(/\s/)[0] : head.slice(0, boundary);
  }
  return head.replace(/[\s.,;:!?-]+$/, '');
};
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
  const idle = [];

  for (const a of agents) {
    const task = a.task ? ` "${a.task}"` : '';
    if (a.state === 'stuck') {
      attention.push({ id: a.id, name: a.name, text: `${a.name} is stuck${a.stuck_reason ? `: ${shorten(a.stuck_reason, MAX_REASON_CHARS)}` : ''}` });
    } else if (a.state === 'error') {
      attention.push({ id: a.id, name: a.name, text: `${a.name} hit an error` });
    } else if (a.state === 'working') {
      working.push({ id: a.id, name: a.name, text: a.task ? `${a.name} is working on${task}` : `${a.name} is working` });
    } else if (a.state === 'done') {
      finished.push({ id: a.id, name: a.name, text: a.task ? `${a.name} finished${task}` : `${a.name} is done` });
    } else if (a.state === 'paused') {
      paused.push({ id: a.id, name: a.name, text: `${a.name} is paused` });
    } else if (a.state === 'idle') {
      idle.push({ id: a.id, name: a.name, text: `${a.name} is idle` });
    }
  }
  for (const ap of context.pending_approvals ?? []) {
    const who = names.get(ap.agent_id) ?? 'An agent';
    const existing = [attention, working, finished, paused, idle].flat().find(item => item.id === ap.agent_id);
    for (const group of [attention, working, finished, paused, idle]) {
      const index = group.findIndex(item => item.id === ap.agent_id);
      if (index >= 0) group.splice(index, 1);
    }
    const suffix = existing ? `; it ${existing.text.slice(who.length).trim()}` : '';
    attention.push({ id: ap.agent_id, name: who, text: `${who} wants to ${approvalWords(ap.action)} and needs your approval${suffix}` });
  }

  const lastCall = (context.recent_summaries ?? []).find(s => s.channel === 'facetime' && s.summary?.trim());
  const recapSentence = lastCall?.summary.trim().split(/(?<=[.!?])\s+/)
    .find(part => [...part.matchAll(/\bAgent(?:\s+|-)\d+\b/gi)].length <= 1);
  const recapText = recapSentence ? shorten(recapSentence, 120) : '';
  const live = [...attention, ...working, ...finished, ...paused, ...idle];
  if (recapText) {
    const mentions = [...recapText.matchAll(/\bAgent(?:\s+|-)\d+\b/gi)]
      .map(m => m[0].replace(/[-\s]+/g, ' ').toLowerCase());
    const matched = mentions.length === 1 && live.find(item => item.name.toLowerCase() === mentions[0]);
    // A multi-agent or repeated-name recap cannot be merged unambiguously with current statuses.
    const safeRecap = mentions.length <= 1;
    let recap = safeRecap ? `Last call: ${recapText}` : '';
    if (matched) {
      const tail = matched.text.slice(matched.name.length).trim();
      recap = `${recap.replace(/[.!?]+$/, '')}; it ${tail}`;
      live.splice(live.indexOf(matched), 1);
    }
    const clauses = [...(recap ? [recap] : []), ...live.map(item => item.text)];
    if (!clauses.length) clauses.push('No agents are running');
    return `${PREFIX} ${clauses.map(sentence).join(' ')}`;
  }
  const clauses = live.map(item => item.text);
  if (!clauses.length) return `${PREFIX} No agents are running.`;
  return `${PREFIX} ${clauses.map(sentence).join(' ')}`;
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
