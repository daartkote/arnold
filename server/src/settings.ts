import type { FastifyInstance } from 'fastify';

export interface VoiceSettings {
  speculativeTurn: boolean;
  turnTimeout: number;
  dryRun: boolean;
}

export const settings: VoiceSettings = { speculativeTurn: false, turnTimeout: 10, dryRun: false };

const KEY = process.env.ELEVENLABS_API_KEY ?? '';
const AGENT = process.env.ELEVENLABS_AGENT_ID ?? '';

async function patchAgent(body: unknown) {
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${AGENT}`, {
    method: 'PATCH',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<{ conversation_config: { turn: { speculative_turn: boolean; turn_timeout: number } } }>;
}

export async function syncAgentTurnSettings() {
  const data = await patchAgent({ conversation_config: { turn: { speculative_turn: settings.speculativeTurn, turn_timeout: settings.turnTimeout } } });
  settings.speculativeTurn = data.conversation_config.turn.speculative_turn;
  settings.turnTimeout = data.conversation_config.turn.turn_timeout;
  return settings;
}

export function registerSettings(app: FastifyInstance) {
  app.get('/api/settings', async () => settings);
  app.post<{ Body: Partial<VoiceSettings> }>('/api/settings', async (req, reply) => {
    const b = req.body ?? {};
    const touchesAgent = b.speculativeTurn !== undefined || b.turnTimeout !== undefined;
    if (typeof b.dryRun === 'boolean') settings.dryRun = b.dryRun;
    if (typeof b.speculativeTurn === 'boolean') settings.speculativeTurn = b.speculativeTurn;
    if (typeof b.turnTimeout === 'number' && b.turnTimeout >= 1 && b.turnTimeout <= 30) settings.turnTimeout = b.turnTimeout;
    if (touchesAgent) {
      try {
        await syncAgentTurnSettings();
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message, settings });
      }
    }
    return settings;
  });
}
