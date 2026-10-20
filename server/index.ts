import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { AgentRequest, ServerStatus, type AgentEvent } from '../shared/agent-protocol';
import { budgetLeft } from './budget';
import { runAgent } from './agent';
import { config, log } from './config';

const buckets = new Map<string, { count: number; resetAt: number }>();
/** Fixed one-minute window per client and endpoint. Returns false once the client is over the limit. */
function allow(key: string, limit: number) {
  const now = Date.now();
  for (const [name, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(name);
  const bucket = buckets.get(key) ?? { count: 0, resetAt: now + 60_000 };
  buckets.set(key, bucket);
  return ++bucket.count <= limit;
}
const Token = z.object({ token: z.string().min(1), expires_at: z.string() });
export async function readBoundedBody(request: Request, limit = 256_000) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0; let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RangeError('Request too large'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
export async function handleRequest(request: Request, ip = 'local'): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin && !config().ALLOWED_ORIGINS.includes(origin) && (url.pathname === '/api/agent' || url.pathname === '/api/gradium/token')) return Response.json({ error: 'Origin not allowed' }, { status: 403 });
  if (url.pathname === '/api/status' && request.method === 'GET') {
    return Response.json(ServerStatus.parse({ voice: Boolean(config().GRADIUM_API_KEY) }), { headers: { 'cache-control': 'no-store' } });
  }
  if (url.pathname === '/api/gradium/token' && request.method === 'GET') {
    const key = config().GRADIUM_API_KEY;
    if (!key) return Response.json({ error: 'Voice is not configured' }, { status: 503 });
    if (!await budgetLeft()) return Response.json({ error: 'This demo has used its monthly budget. Try again next month.' }, { status: 503 });
    if (!allow(`voice:${ip}`, 30)) return Response.json({ error: 'Too many voice connections' }, { status: 429, headers: { 'retry-after': '60' } });
    try {
      const upstream = await fetch('https://api.gradium.ai/api/api-keys/token', { headers: { 'x-api-key': key }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]) });
      if (!upstream.ok) throw new Error('Gradium token request failed');
      return Response.json(Token.parse(await upstream.json()), { headers: { 'cache-control': 'no-store' } });
    } catch { log('gradium_token_failed'); return Response.json({ error: 'Could not connect to Gradium' }, { status: 502 }); }
  }
  if (url.pathname === '/api/agent' && request.method === 'POST') {
    // Talking fast sends a phrase every second or two, plus suggestions and tidy-ups; this caps a scripted abuser of the shared key.
    if (!allow(`agent:${ip}`, 90)) return Response.json({ error: 'Too many requests. Wait a minute and try again.' }, { status: 429, headers: { 'retry-after': '60' } });
    if (!await budgetLeft()) return Response.json({ error: 'This demo has used its monthly budget. Try again next month.' }, { status: 503 });
    if (Number(request.headers.get('content-length') ?? 0) > 256_000) return Response.json({ error: 'Request too large' }, { status: 413 });
    let input: AgentRequest;
    try { input = AgentRequest.parse(JSON.parse(await readBoundedBody(request))); }
    catch (error) { return Response.json({ error: error instanceof RangeError ? 'Request too large' : 'Invalid agent request' }, { status: error instanceof RangeError ? 413 : 400 }); }
    const abort = new AbortController();
    const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(120_000)]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: AgentEvent) => { if (!signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); };
        void (async () => {
          try { await runAgent({ request, input, signal, emit }); }
          catch (error) {
            if (!signal.aborted) {
              log('agent_failed', { kind: error instanceof Error ? error.name : 'unknown' });
              emit({ type: 'error', message: 'Could not complete that turn. Please try again.' });
            }
          } finally { if (!signal.aborted) { emit({ type: 'done' }); controller.close(); } else { try { controller.close(); } catch {} } }
        })();
      },
      cancel() { abort.abort(); },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
  }
  if (url.pathname.startsWith('/api/')) return Response.json({ error: 'Not found' }, { status: 404 });
  if (process.env.NODE_ENV === 'production' && (request.method === 'GET' || request.method === 'HEAD')) {
    const root = resolve('dist');
    const target = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (target !== root && !target.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
    const file = Bun.file(target);
    if (await file.exists()) return new Response(request.method === 'HEAD' ? null : file, { headers: { 'content-type': file.type } });
    const fallback = Bun.file(resolve(root, 'index.html'));
    if (await fallback.exists()) return new Response(request.method === 'HEAD' ? null : fallback, { headers: { 'content-type': 'text/html' } });
  }
  return new Response('Not found', { status: 404 });
}
/** Behind a host's proxy (TRUST_PROXY=1) every request arrives from the proxy, so rate limits key on the forwarded client address instead. */
function clientIp(request: Request, direct: string | undefined) {
  const forwarded = config().TRUST_PROXY ? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined;
  return forwarded || direct;
}
if (import.meta.main) {
  const server = Bun.serve({ hostname: config().API_HOST, port: config().API_PORT, idleTimeout: 120, fetch: (request, server) => handleRequest(request, clientIp(request, server.requestIP(request)?.address)),
    error() { log('request_failed'); return Response.json({ error: 'Internal server error' }, { status: 500 }); },
  });
  log('server_started', { port: server.port ?? config().API_PORT });
}
