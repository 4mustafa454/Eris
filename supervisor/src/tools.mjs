// PM tools for the voice agent. Names, descriptions and argument schemas come from shared/pm/tools.json,
// the same list the web chat uses. Implemented: get_status, explain_agent (M1) and show_grid, focus_agent (M2,
// they switch the video); the rest answer "not available yet" until their milestones.
//
// Logging (AGENTS.md §5.3, log exactly once): read-only/display tools are logged by the caller, here, via
// POST /sessions/{id}/actions. Mutating tools are logged by their own harness route once they exist,
// so their "not available yet" stubs log nothing.
import { llm } from '@livekit/agents';
import { HarnessError } from './harness.mjs';
import { loadTools } from './pm-prompt.mjs';

const READ_ONLY = new Set(['get_status', 'explain_agent', 'show_grid', 'focus_agent', 'search_history']);
const NOT_AVAILABLE = 'not available yet';
const UNREACHABLE = "I can't reach the team right now.";
const LOG_LINES = 20;
const NO_VIDEO = "The video isn't available on this call.";
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
 */
const implementations = (harness, display) => ({
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
 *           defs?: ReturnType<typeof loadTools> }} deps  `log` is the session logger; `defs` defaults to tools.json
 * @returns {Record<string, any>} a ToolContext: tool name → llm.tool, ready for voice.Agent({ tools })
 */
export function buildTools({ harness, log, display, defs = loadTools() }) {
  const handlers = implementations(harness, display);
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
