import { z } from 'zod';

const Config = z.object({
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LWC_SECRET: z.string().min(16).optional(),
  GRADIUM_API_KEY: z.string().default(''),
  DEV_LLM_BASE_URL: z.url().optional(),
  DEV_LLM_API_KEY: z.string().default('dev-only'),
  DEV_LLM_MODEL: z.string().default('gpt-6-luna'),
  DEV_IMAGE_MODEL: z.string().default('gpt-image-1'),
  /** Extra browser origins allowed to call the API, comma separated. Needed behind an HTTPS proxy such as Tailscale Serve. */
  ALLOWED_ORIGINS: z.string().default('').transform(value => value.split(',').map(origin => origin.trim()).filter(Boolean)),
});
export function config() {
  return Config.parse(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== '')));
}
export function log(event: string, fields: Record<string, string | number | boolean> = {}) {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}
