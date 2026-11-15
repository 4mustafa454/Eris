// One call, end to end: join, wait for the caller, open a session, run the PM, log it, greet once, clean up.
// Everything outside the framework is injected, so call.test.mjs drives the whole flow with fakes.
import { AutoSubscribe, voice as livekitVoice } from '@livekit/agents';
import { armGreeting, resolveGreeting } from './greeting.mjs';
import { createSessionLogger } from './harness.mjs';
import { renderPrompt } from './pm-prompt.mjs';
import { buildTools } from './tools.mjs';

// Roles in the transcript (§4): the framework says "assistant", the harness says "pm".
const TRANSCRIPT_ROLE = { user: 'user', assistant: 'pm' };

const NO_STATUS_NOTE =
  '\n\nNote: the team status could not be loaded when this session started. Call get_status before answering questions about the agents.';
const EMPTY_CONTEXT = { recent_summaries: [], agents: [], open_tasks: [], pending_approvals: [] };

/**
 * @param {any} ctx job context: room, connect(), waitForParticipant(), addShutdownCallback()
 * @param {{
 *   config: { greetOnJoin: boolean },
 *   harness: ReturnType<typeof import('./harness.mjs').createHarness>,
 *   createProviders: () => { stt: any, tts: any, llm: any },
 *   vad: any,
 *   voice?: typeof livekitVoice,
 *   log?: Pick<Console, 'info' | 'warn' | 'error'>,
 * }} deps
 */
export async function handleCall(ctx, { config, harness, createProviders, vad, voice = livekitVoice, log = console }) {
  // Join promptly so Chert can find us; open nothing paid until a caller exists (doctor jobs never get one).
  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
  const caller = await ctx.waitForParticipant();

  const providers = createProviders();
  const [session, context] = await Promise.all([
    harness.createSession('facetime').catch(error => { log.warn(`[eris] no session logging: ${error.message}`); return null; }),
    harness.getContext().catch(error => { log.warn(`[eris] team status unavailable: ${error.message}`); return null; }),
  ]);
  const logger = createSessionLogger(harness, session?.id, error => log.warn(`[eris] logging failed: ${error.message}`));
  const instructions = renderPrompt(context ?? EMPTY_CONTEXT) + (context ? '' : NO_STATUS_NOTE);

  const agentSession = new voice.AgentSession({
    stt: providers.stt,
    llm: providers.llm,
    tts: providers.tts,
    vad,
    // The default end-of-turn detector needs LiveKit's inference executor, which Chert rooms do not have.
    turnDetection: 'vad',
  });

  // Every final turn, either side, in order. The spoken greeting arrives here too, so it is not logged twice.
  agentSession.on('conversation_item_added', ({ item }) => {
    const role = TRANSCRIPT_ROLE[item?.role];
    const text = item?.textContent?.trim();
    if (item?.type === 'message' && role && text) logger.message(role, text);
  });
  agentSession.on('error', event => log.error(`[eris] session error: ${event?.error?.message ?? 'unknown'}`));

  let ended = false;
  const markEnded = () => { if (!ended) { ended = true; logger.end(); } };
  agentSession.on('close', markEnded); // the caller hung up

  await agentSession.start({
    room: ctx.room,
    agent: new voice.Agent({ instructions, tools: buildTools({ harness, log: logger }) }),
    record: false,
    inputOptions: {
      participantIdentity: caller.identity,
      audioEnabled: true,
      videoEnabled: false,
      textEnabled: false,
      closeOnDisconnect: true,
      deleteRoomOnClose: false,
    },
    outputOptions: { audioEnabled: true, transcriptionEnabled: false },
  });

  // Greet once on Chert's bridge_ready (never on arrival): the Mac ends a call that hears nothing within
  // 10 s of it. The text is a template over fresh agent state, so nothing here waits on an LLM.
  const stopGreeting = armGreeting({
    room: ctx.room,
    callerIdentity: caller.identity,
    greetOnJoin: config.greetOnJoin,
    greet: async () => {
      const text = await resolveGreeting({ fetchContext: () => harness.getContext(), cached: context });
      agentSession.say(text);
    },
    onError: error => log.error(`[eris] greeting failed: ${error?.message ?? error}`),
  });

  ctx.addShutdownCallback(async () => {
    stopGreeting();
    try { await agentSession.close(); } catch { /* already closed */ }
    markEnded();
    await logger.flush();
  });
}
