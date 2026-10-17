import { z } from 'zod';

const Config = z.object({
  ALLOW_DEV_LLM_IN_PRODUCTION: z.enum(['0', '1']).default('0').transform(value => value === '1'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LWC_SECRET: z.string().min(16).optional(),
  GRADIUM_API_KEY: z.string().default(''),
  DEV_LLM_BASE_URL: z.url().optional(),
  DEV_LLM_API_KEY: z.string().default('dev-only'),
  DEV_LLM_MODEL: z.string().default('gpt-6.1-sol'),
  DEV_LLM_REASONING_EFFORT: z.enum(['none', 'minimal', 'low']).default('none'),
  DEV_IMAGE_MODEL: z.string().default('gpt-image-1'),
  /** Extra browser origins allowed to call the API, comma separated. Needed behind an HTTPS proxy such as Tailscale Serve. */
  ALLOWED_ORIGINS: z.string().default('').transform(value => value.split(',').map(origin => origin.trim()).filter(Boolean)),
});
export function config() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''));
  // Ignore even malformed dev settings in production unless explicitly enabled.
  if (env.NODE_ENV === 'production' && env.ALLOW_DEV_LLM_IN_PRODUCTION !== '1') {
    for (const key of Object.keys(env)) if (key.startsWith('DEV_LLM_') || key === 'DEV_IMAGE_MODEL') delete env[key];
  }
  return Config.parse(env);
}
export function log(event: string, fields: Record<string, string | number | boolean> = {}) {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}
