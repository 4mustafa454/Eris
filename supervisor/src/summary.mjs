import { llm as livekitLlm } from '@livekit/agents';

const TIMEOUT_MS = 5000;
const MAX_WORDS = 60;
const FILLER = /\b(?:no (?:other|additional) actions? (?:were|was|have been) recorded|must be requested)\b/i;
// Preserve identifiers, including underscores and backticks' contents.
const plain = value => String(value ?? '').replace(/\s+/g, ' ').replace(/[*#`]/g, '').trim();

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

function spokenRecap(text) {
  let value = String(text ?? '');
  // Snapshot headings mark a model-echoed block, not part of the conversation recap.
  value = value.replace(/\b(?:agent states and tasks|current team snapshot)\s*:[\s\S]*$/i, '');
  value = value.replace(/\bagent\s+\d+\s*:\s*(?:idle|working|stuck|done|error|paused)\b[\s\S]*$/i, '');
  value = value.split(/\r?\n/).filter(line =>
    !/^\s*[-*#]*\s*agent\s+\d+\s*:\s*(?:idle|working|stuck|done|error|paused)\b/i.test(line),
  ).join(' ');
  value = plain(value.replace(/\bsummary\s*:\s*/gi, ''));
  const sentences = value.split(/(?<=[.!?])\s+/).map(s => s.trim())
    .filter(s => s && !FILLER.test(s));
  const kept = [];
  let words = 0;
  for (const sentence of sentences) {
    const count = sentence.split(/\s+/).length;
    if (kept.length === 3 || words + count > MAX_WORDS) break;
    kept.push(/[.!?]$/.test(sentence) ? sentence : `${sentence}.`);
    words += count;
  }
  return kept.join(' ');
}

/** Produce a concise spoken call recap; the team snapshot is input, never appended. */
export async function summarizeCall(provider, transcript, actions, team, timeoutMs = TIMEOUT_MS) {
  const fallback = 'The call ended.';
  if (!provider?.chat || !transcript.length) return fallback;
  let stream;
  let timer;
  try {
    const chatCtx = livekitLlm.ChatContext.empty();
    chatCtx.addMessage({ role: 'system', content: 'Summarize the call in at most three concise factual sentences and about 60 words, written to be spoken. Mention meaningful decisions or unfinished work. Use the team snapshot only as context; do not repeat it or list agent states. Do not invent facts or include filler such as "No other actions were recorded" or "must be requested". Do not use labels or headings.' });
    const lines = transcript.map(m => `${m.role}: ${m.text}`).join('\n');
    const toolLines = actions.map(a => `${a.tool}: ${JSON.stringify(a.args ?? {})}`).join('\n');
    const teamLines = team ? team.map(a => `${a.name}: ${a.state}; task: ${a.task}`).join('\n') : 'Team status unavailable.';
    chatCtx.addMessage({ role: 'user', content: `Current team snapshot:\n${teamLines}\nTranscript:\n${lines.slice(-24000)}\nActions:\n${toolLines.slice(-4000)}` });
    stream = provider.chat({ chatCtx });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('summary timeout')), timeoutMs); });
    const result = await Promise.race([stream.collect(), timeout]);
    return spokenRecap(result?.text) || fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    try { stream?.close(); } catch { /* the provider is already closed */ }
  }
}
