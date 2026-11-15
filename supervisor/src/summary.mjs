import { llm as livekitLlm } from '@livekit/agents';

const TIMEOUT_MS = 5000;
const FILLER = /\b(?:no (?:other|additional) actions? (?:were|was|have been) recorded|must be requested)\b/i;
const plain = value => String(value ?? '').replace(/\s+/g, ' ').replace(/[*_`#]/g, '').trim();
const speakable = value => plain(value).replace(/[.!?]+(?=\s|$)/g, ',').replace(/[,;\s]+$/, '');

/** Use the linked task first; otherwise use the most recent non-queued task from the harness. */
export function teamSnapshot(agents, tasks = null) {
  if (!Array.isArray(agents)) return null;
  return agents.map(agent => {
    const previous = Array.isArray(tasks)
      ? tasks.filter(t => t.agent_id === agent.id && t.status !== 'queued')
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0]
      : null;
    return {
      name: plain(agent.name),
      state: plain(agent.state),
      task: plain(agent.task || previous?.title) || (Array.isArray(tasks) ? 'no task recorded' : 'task unavailable'),
    };
  });
}

function teamSentence(team) {
  if (!team) return 'The team status is unavailable.';
  if (!team.length) return 'No agents are running.';
  return team.map(a => {
    const name = speakable(a.name);
    const state = speakable(a.state);
    const status = state === 'error' ? `${name} has an error` : `${name} is ${state}`;
    if (a.task === 'no task recorded') return `${status}, with no task recorded`;
    if (a.task === 'task unavailable') return `${status}, with its task unavailable`;
    const task = speakable(a.task);
    if (state === 'working' || state === 'stuck') return `${status} on ${task}`;
    if (state === 'done') return `${status} with ${task}`;
    return `${status}, last task ${task}`;
  }).join('; ') + '.';
}

function spokenRecap(text) {
  return plain(text).slice(0, 500).split(/(?<=[.!?])\s+/).map(s => s.trim())
    .filter(s => s && !FILLER.test(s)).slice(0, 2)
    .map(s => /[.!?]$/.test(s) ? s : `${s}.`).join(' ');
}

/** Produce a short spoken recap with a factual snapshot, even if the model is unavailable. */
export async function summarizeCall(provider, transcript, actions, team, timeoutMs = TIMEOUT_MS) {
  const status = teamSentence(team);
  const fallback = `The call ended. ${status}`;
  if (!provider?.chat || !transcript.length) return fallback;
  let stream;
  let timer;
  try {
    const chatCtx = livekitLlm.ChatContext.empty();
    chatCtx.addMessage({ role: 'system', content: 'Summarize the call in one or two concise, factual sentences written to be spoken. Mention meaningful decisions or unfinished work. Use the team snapshot for context; a separate sentence will report every agent state and task. Do not invent facts or include filler such as "No other actions were recorded" or "must be requested".' });
    const lines = transcript.map(m => `${m.role}: ${m.text}`).join('\n');
    const toolLines = actions.map(a => `${a.tool}: ${JSON.stringify(a.args ?? {})}`).join('\n');
    const teamLines = team ? team.map(a => `${a.name}: ${a.state}; task: ${a.task}`).join('\n') : 'Team status unavailable.';
    chatCtx.addMessage({ role: 'user', content: `Current team snapshot:\n${teamLines}\nTranscript:\n${lines.slice(-24000)}\nActions:\n${toolLines.slice(-4000)}` });
    stream = provider.chat({ chatCtx });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('summary timeout')), timeoutMs); });
    const result = await Promise.race([stream.collect(), timeout]);
    return `${spokenRecap(result?.text) || 'The call ended.'} ${status}`;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    try { stream?.close(); } catch { /* the provider is already closed */ }
  }
}
