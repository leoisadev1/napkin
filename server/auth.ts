import { createChatGPTHandler, type StoredSession, type KeyValueStore } from '@opencoredev/loginwithchatgpt-server';
import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { z } from 'zod';
import { config, log } from './config';

const User = z.object({ accountId: z.string(), email: z.string().optional(), name: z.string().optional(), plan: z.string().optional() });
const Stored: z.ZodType<StoredSession> = z.object({
  status: z.enum(['unauthenticated', 'pending', 'authenticated', 'expired', 'error']),
  device: z.object({ deviceAuthId: z.string(), userCode: z.string(), verificationUrl: z.string(), interval: z.number(), expiresAt: z.number(), lastPolledAt: z.number() }).optional(),
  tokensCipher: z.string().optional(),
  user: User.optional(), createdAt: z.number(), updatedAt: z.number(),
});
const Envelope = z.object({ version: z.literal(1), expiresAt: z.number(), session: Stored });
const directory = '.data/sessions';
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod('.data', 0o700);
function path(key: string) { return `${directory}/${Bun.CryptoHasher.hash('sha256', key, 'hex')}.json`; }
export const sessionStore: KeyValueStore<StoredSession> = {
  async get(key) {
    try {
      const stored = Envelope.parse(JSON.parse(await readFile(path(key), 'utf8')));
      if (stored.expiresAt < Date.now()) { await this.delete(key); return undefined; }
      return stored.session;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) log('session_read_failed');
      return undefined;
    }
  },
  async set(key, session, options) {
    const target = path(key);
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, expiresAt: Date.now() + (options?.ttlMs ?? 30 * 86400_000), session }), { mode: 0o600 });
    await rename(temp, target);
  },
  async delete(key) { await unlink(path(key)).catch(() => {}); },
};
async function secret() {
  const configured = config().LWC_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') throw new Error('LWC_SECRET is required in production');
  try { return z.string().min(32).parse((await readFile('.data/lwc-secret', 'utf8')).trim()); }
  catch { const value = crypto.randomUUID() + crypto.randomUUID(); await writeFile('.data/lwc-secret', value, { mode: 0o600 }); return value; }
}
export const auth = createChatGPTHandler({ secret: await secret(), sessionStore });
