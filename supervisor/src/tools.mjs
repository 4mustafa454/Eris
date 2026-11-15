// PM tools for the voice agent. Names, descriptions and argument schemas come from shared/pm/tools.json,
// the same list the web chat uses. The available handlers call the corresponding harness routes or switch video.
//
// Logging (AGENTS.md §5.3, log exactly once): read-only/display tools are logged by the caller, here, via
// POST /sessions/{id}/actions. Mutating tools are logged by their own harness route.
import { llm } from '@livekit/agents';
import { HarnessError } from './harness.mjs';
import { loadTools } from './pm-prompt.mjs';

const READ_ONLY = new Set(['get_status', 'explain_agent', 'show_grid', 'focus_agent', 'search_history']);
const NOT_AVAILABLE = 'not available yet';
const UNREACHABLE = "I can't reach the team right now.";
const LOG_LINES = 20;
const NO_VIDEO = "The video isn't available on this call.";
const NO_INSTRUCTION = 'There was no instruction to send.';
const noAgent = n => `There's no agent ${n}.`;

/** Agent number as the PM says it ("agent 2") → harness id, or null when it is not a positive integer. */
export function agentId(n) {
  const value = typeof n === 'string' && /^\d+$/.test(n.trim()) ? Number(n) : n;
  return Number.isInteger(value) && value >= 1 ? `agent-${value}` : null;
}

/** Compact agent view for the model: no ids, colors, or timestamps to read out. */
const brief = a => ({ name: a.name, state: a.state, task: a.task, summary: a.summary, stuck_reason: a.stuck_reason });

/**
 * Every handler returns { result, agentId? } for the model, and never throws.
 * @param {ReturnType<import('./harness.mjs').createHarness>} harness
 * @param {{ setMode(mode: 'grid' | 'focus', agentId?: string): void, snapshot(): { agents?: any[] } } | undefined} display
 *   the video, or undefined when this call has none
 * @param {string | undefined} sessionId  the call's session: send_task passes it so the harness logs the action
 */
const implementations = (harness, display, sessionId) => ({
  async get_status() {
    return { result: { agents: (await harness.getAgents()).map(brief) } };
  },

  async explain_agent({ n }) {
    const id = agentId(n);
    if (!id) return { result: { error: `"${n}" is not a valid agent number.` } };
    let agent;
    try {
      agent = await harness.getAgent(id);
    } catch (error) {
      if (error instanceof HarnessError && error.status === 404) return { result: { error: `Agent ${n} doesn't exist.` } };
      throw error;
    }
    const { lines } = await harness.getLog(id, LOG_LINES);
    return { result: { agent: brief(agent), recent_activity: lines }, agentId: id };
  },

  // Mutating tools are logged by the harness route (AGENTS.md §5.3), so nothing here logs them.
  async send_task({ n, instruction }) {
    const id = agentId(n);
    if (!id) return { result: { error: noAgent(n) } };
    const text = typeof instruction === 'string' ? instruction.trim() : '';
    if (!text) return { result: { error: NO_INSTRUCTION } };
    try {
      const state = await harness.sendTask(id, text, sessionId);
      return { result: { sent: true, agent: state.name, state: state.state, task: state.task, instruction: text.slice(0, 120) } };
    } catch (error) {
      if (error instanceof HarnessError && error.status === 404) return { result: { error: noAgent(n) } };
      if (error instanceof HarnessError && error.status === 422) return { result: { error: NO_INSTRUCTION } };
      throw error;
    }
  },

  async pause_agent({ n }) {
    const id = agentId(n);
    if (!id) return { result: { error: noAgent(n) } };
    try { return { result: { agent: brief(await harness.pauseAgent(id, sessionId)) } }; }
    catch (error) { if (error instanceof HarnessError && error.status === 404) return { result: { error: noAgent(n) } }; throw error; }
  },

  async resume_agent({ n }) {
    const id = agentId(n);
    if (!id) return { result: { error: noAgent(n) } };
    try { return { result: { agent: brief(await harness.resumeAgent(id, sessionId)) } }; }
    catch (error) { if (error instanceof HarnessError && error.status === 404) return { result: { error: noAgent(n) } }; throw error; }
  },

  async create_task({ title, instruction, agent }) {
    if (typeof title !== 'string' || !title.trim() || typeof instruction !== 'string' || !instruction.trim()) {
      return { result: { error: 'A task title and instruction are required.' } };
    }
    const id = agent == null ? null : agentId(agent);
    if (agent != null && !id) return { result: { error: noAgent(agent) } };
    try {
      const task = await harness.createTask(title.trim(), instruction.trim(), id, sessionId);
      return { result: { task, queued: task.status === 'queued' } };
    } catch (error) { if (error instanceof HarnessError && error.status === 404) return { result: { error: noAgent(agent) } }; throw error; }
  },

  async decide_approval({ id, decision }) {
    if (typeof id !== 'string' || !id.trim() || !['approved', 'denied'].includes(decision)) {
      return { result: { error: 'An approval and a clear decision are required.' } };
    }
    try { return { result: { approval: await harness.decideApproval(id, decision, sessionId) } }; }
    catch (error) {
      if (error instanceof HarnessError && error.status === 404) return { result: { error: 'That approval was not found.' } };
      if (error instanceof HarnessError && error.status === 409) return { result: { error: 'That approval has already been decided.' } };
      throw error;
    }
  },

  async search_history({ query }) {
    if (typeof query !== 'string' || !query.trim()) return { result: { error: 'A search query is required.' } };
    return { result: { hits: await harness.searchHistory(query.trim()) } };
  },

  async stop_all() {
    const stopped = await harness.stopAll();
    return { result: { stopped: true, agents: stopped.map(brief) } };
  },

  async show_grid() {
    if (!display) return { result: { error: NO_VIDEO } };
    display.setMode('grid');
    return { result: { showing: 'the grid of all agents' } };
  },

  async focus_agent({ n }) {
    const id = agentId(n);
    if (!id) return { result: { error: noAgent(n) } };
    if (!display) return { result: { error: NO_VIDEO } };
    // The polled list is what the video draws, so it decides. Only when it is empty (harness down at the last
    // poll, or not polled yet) is the harness asked directly.
    const known = display.snapshot().agents ?? [];
    let agent = known.find(a => a.id === id);
    if (!agent && known.length === 0) {
      try {
        agent = await harness.getAgent(id);
      } catch (error) {
        if (!(error instanceof HarnessError && error.status === 404)) throw error;
      }
    }
    // No agentId on a miss: actions.agent_id references agents, so an unknown id would fail to log.
    if (!agent) return { result: { error: noAgent(n) } };
    display.setMode('focus', id);
    return { result: { showing: `${agent.name}, full screen` }, agentId: id };
  },
});

/**
 * @param {{ harness: ReturnType<import('./harness.mjs').createHarness>,
 *           log: { action(a: object): void },
 *           display?: Parameters<typeof implementations>[1],
 *           sessionId?: string,
 *           defs?: ReturnType<typeof loadTools> }} deps  `log` is the session logger; `defs` defaults to tools.json
 * @returns {Record<string, any>} a ToolContext: tool name → llm.tool, ready for voice.Agent({ tools })
 */
export function buildTools({ harness, log, display, sessionId, defs = loadTools() }) {
  const handlers = implementations(harness, display, sessionId);
  const known = new Set(defs.map(d => d.name));
  for (const name of Object.keys(handlers)) {
    if (!known.has(name)) throw new Error(`tools.mjs implements "${name}", which is not in shared/pm/tools.json`);
  }

  const tools = {};
  for (const def of defs) {
    const handler = handlers[def.name];
    tools[def.name] = llm.tool({
      description: def.description,
      parameters: def.parameters,
      execute: async args => {
        const input = args ?? {};
        let result;
        let agent;
        if (handler) {
          try {
            ({ result, agentId: agent } = await handler(input));
          } catch {
            result = { error: UNREACHABLE };
          }
        } else {
          result = NOT_AVAILABLE;
        }
        if (READ_ONLY.has(def.name)) {
          log.action({
            tool: def.name,
            args: input,
            result: typeof result === 'string' ? { available: false } : result,
            ...(agent ? { agent_id: agent } : {}),
          });
        }
        return result;
      },
    });
  }
  return tools;
}
