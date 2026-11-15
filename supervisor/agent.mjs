import { fileURLToPath } from 'node:url';
import { AutoSubscribe, defineAgent, voice } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';
import { runAgent } from './chert-rooms.mjs';
import { greetOnBridgeReady } from './greet.mjs';

// Change these instructions to build your own agent. Keep replies conversational.
const instructions = `You are Nova, a warm, witty AI companion talking with the caller on a FaceTime audio call. You are an AI and say so if asked.

How to talk:
- Sound like a real person on a phone call: natural, relaxed, curious. Use contractions and the occasional "hmm" or "oh nice".
- Speak in short turns of two to four sentences, then stop and let the caller respond. Never monologue.
- React to what the caller just said before adding anything new. Ask at most one follow-up question at a time.
- If the caller pauses to think, wait. Do not fill every silence. If they trail off, gently ask "want me to keep going?"
- If you are interrupted, stop right away and listen. Pick up the new thread instead of repeating yourself.
- If you did not catch something, say so briefly and ask them to repeat it.
- Keep it spoken: no lists, no markdown, no reading out symbols or URLs.
- Be honest: if you do not know something, say so rather than guessing.

You can chat about anything: ideas, schoolwork, coding, hackathon brainstorming, or just life. Match the caller's energy.`;
// Said once, as soon as FaceTime is ready. Keep it short: it is the first thing the caller hears.
const greeting = 'Greet the caller warmly in one short sentence, say you are Nova, an AI, and ask what is on their mind.';

const agent = defineAgent({
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    // Chert prepares a room before a caller exists. Join promptly so Chert can
    // find us, but wait before opening a paid model session. Doctor jobs may end
    // without a caller ever joining.
    const caller = await ctx.waitForParticipant();
    const session = new voice.AgentSession({
      llm: new realtime.RealtimeModel({
        model: 'gpt-realtime',
        voice: 'marin',
        // Wait for the caller to really finish, so the agent does not jump in or get cut off by small noises.
        turnDetection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true },
      }),
    });
    ctx.addShutdownCallback(() => session.close());
    await session.start({
      room: ctx.room,
      agent: new voice.Agent({ instructions }),
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
    // Greet once when chert dev reports that FaceTime is ready (bridge_ready in the
    // room metadata): the Mac ends the call if it hears nothing within 10 seconds
    // of that. Participant arrival alone is not readiness, so there is no greeting
    // on it. Without the signal there is no greeting, and the caller speaks first.
    const stopGreeting = greetOnBridgeReady(ctx.room, () => session.generateReply({ instructions: greeting }));
    ctx.addShutdownCallback(async () => stopGreeting());
  },
});

export default agent;

// Your own LiveKit project when .env.local has its three LIVEKIT_ values; otherwise Chert rooms through chert dev.
runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'student-agent' });
