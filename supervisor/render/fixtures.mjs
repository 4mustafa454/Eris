// Fixed AgentState fixtures (AGENTS.md §5.1) for renderer tests and the sample dump.
const T = '2026-11-14T19:02:11Z';
const agent = (n, state, extra = {}) => ({
  id: `agent-${n}`, name: `Agent ${n}`, color: ['#7F77DD', '#1D9E75', '#D85A30'][(n - 1) % 3],
  engine: 'claude-code', state, task: `Task for agent ${n}`, summary: null, stuck_reason: null, updated_at: T, ...extra,
});

export const LONG_TITLE = 'Refactor the entire signup flow to validate every field, normalise email addresses, ' +
  'reject disposable domains, add rate limiting, and write migration scripts for existing users '.repeat(1).padEnd(200, '.');
export const LONG_LINE = 'run pytest -q tests/test_signup.py::test_validation_of_extremely_long_inputs → 2 failed, 14 passed; '.repeat(3);
export const NO_SPACES = 'x'.repeat(120);
export const LONG_REASON = 'Should I use the v1 or the v2 endpoint? The docs disagree and the tests call both, so I cannot tell which one the signup form is meant to hit.';

export const LOG = ['read signup.py', 'edit signup.py', 'run pytest → 2 failed', 'edit test_signup.py', 'run pytest → passed', 'git commit'];

/** One agent per state. */
export const SIX_STATES = ['idle', 'working', 'stuck', 'done', 'error', 'paused'].map((s, i) =>
  agent(i + 1, s, s === 'stuck' ? { stuck_reason: LONG_REASON } : {}));

export const ONE = [agent(1, 'working', { task: 'Add input validation to /signup' })];
export const TWO = [agent(1, 'done'), agent(2, 'working')];
export const THREE = [
  agent(1, 'stuck', { task: 'Add input validation to /signup', stuck_reason: 'v1 or v2 endpoint?' }),
  agent(2, 'working', { task: 'Write tests' }),
  agent(3, 'done', { task: 'Rename the package' }),
];
export const LONG = [
  agent(1, 'stuck', { task: LONG_TITLE, stuck_reason: LONG_REASON }),
  agent(2, 'working', { task: NO_SPACES }),
  agent(3, 'idle', { task: null }),
];

export const logsFor = (agents, lines = LOG) => Object.fromEntries(agents.map(a => [a.id, [...lines]]));
export const LONG_LOGS = { 'agent-1': [LONG_LINE, NO_SPACES, ...LOG, ...LOG], 'agent-2': [LONG_LINE], 'agent-3': [] };

/** name → model, for tests and the sample dump. */
export const MODELS = {
  one: { agents: ONE, logs: logsFor(ONE) },
  two: { agents: TWO, logs: logsFor(TWO) },
  three: { agents: THREE, logs: logsFor(THREE) },
  'six-states': { agents: SIX_STATES, logs: logsFor(SIX_STATES) },
  long: { agents: LONG, logs: LONG_LOGS },
};
