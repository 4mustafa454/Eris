// The shared PM brain, Node side. A port of harness/app/pm.py: same template, same {{name}} rendering,
// same text for the two placeholders. pm-prompt.test.mjs runs both implementations and requires
// byte-identical output, so change them together.
//
// Template format (documented at the top of shared/pm/system_prompt.md): strip the leading comment,
// then plain literal {{name}} replacement. No escaping, conditionals, or nesting.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PM_DIR = fileURLToPath(new URL('../../shared/pm/', import.meta.url));

// \x3E is the greater-than sign, escaped so this comment-stripping regex never contains the marker itself.
const LEADING_COMMENT = /^\s*<!--[\s\S]*?--\x3E\s*/;

export function loadTools(dir = PM_DIR) {
  return JSON.parse(readFileSync(`${dir}tools.json`, 'utf8'));
}

/** The prompt template with its leading documentation comment stripped. */
export function loadTemplate(dir = PM_DIR) {
  return readFileSync(`${dir}system_prompt.md`, 'utf8').replace(LEADING_COMMENT, '');
}

/** One line per recent session summary, from GET /context. */
export function formatLastTime(context) {
  const items = context.recent_summaries || [];
  if (!items.length) return 'No previous conversations.';
  return items.map(s => `- [${s.channel}, ${s.ended_at || 'unknown time'}] ${s.summary}`).join('\n');
}

/** One line per agent, then queued tasks and pending approvals, from GET /context. */
export function formatCurrentState(context) {
  const agents = context.agents || [];
  const names = new Map(agents.map(a => [a.id, a.name]));
  const lines = [];
  for (const a of agents) {
    let line = `- ${a.name} (${a.state}, ${a.engine}): ${a.task || 'no task'}.`;
    if (a.summary) line += ` ${a.summary}.`;
    if (a.stuck_reason) line += ` BLOCKED: ${a.stuck_reason}`;
    lines.push(line);
  }
  for (const t of context.open_tasks || []) {
    if (t.status === 'queued') lines.push(`- Queued task: ${t.title}`);
  }
  for (const ap of context.pending_approvals || []) {
    const who = names.get(ap.agent_id) ?? ap.agent_id;
    const detail = ap.detail ? ` (${ap.detail})` : '';
    lines.push(`- Approval ${ap.id}: ${who} wants to ${ap.action}${detail}`);
  }
  return lines.length ? lines.join('\n') : 'No agents.';
}

/** Fills the template from a GET /context response. */
export function renderPrompt(context, dir = PM_DIR) {
  const values = {
    what_happened_last_time: formatLastTime(context),
    current_state: formatCurrentState(context),
  };
  let text = loadTemplate(dir);
  // A function replacer keeps "$&", "$1" and "$'" in the values literal, as Python's str.replace does.
  for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{{${key}}}`, () => value);
  return text;
}
