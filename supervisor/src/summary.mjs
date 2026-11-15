import { llm as livekitLlm } from '@livekit/agents';

const TIMEOUT_MS = 5000;

/** Summarize the finished call with the configured PM model; never delay shutdown indefinitely. */
export async function summarizeCall(provider, transcript, actions, timeoutMs = TIMEOUT_MS) {
  const fallback = `The call ended. It included ${transcript.filter(m => m.role === 'user').length} user messages and ${actions.length} recorded actions.`;
  if (!provider?.chat || !transcript.length) return fallback;
  let stream;
  let timer;
  try {
    const chatCtx = livekitLlm.ChatContext.empty();
    chatCtx.addMessage({ role: 'system', content: 'Summarize this finished call in 2–3 concise factual sentences. Mention decisions and unfinished work. Do not invent facts.' });
    const lines = transcript.map(m => `${m.role}: ${m.text}`).join('\n');
    const toolLines = actions.map(a => `${a.tool}: ${JSON.stringify(a.args ?? {})}`).join('\n');
    chatCtx.addMessage({ role: 'user', content: `Transcript:\n${lines.slice(-24000)}\nActions:\n${toolLines.slice(-4000)}` });
    stream = provider.chat({ chatCtx });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('summary timeout')), timeoutMs); });
    const result = await Promise.race([stream.collect(), timeout]);
    return result?.text?.trim().slice(0, 1000) || fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    try { stream?.close(); } catch { /* the provider is already closed */ }
  }
}
