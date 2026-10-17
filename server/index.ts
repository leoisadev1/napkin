import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { AgentRequest, ServerStatus, type AgentEvent } from '../shared/agent-protocol';
import { auth } from './auth';
import { runAgent } from './agent';
import { config, log } from './config';

const buckets = new Map<string, { count: number; resetAt: number }>();
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
  if (origin && origin !== url.origin && (url.pathname === '/api/agent' || url.pathname === '/api/gradium/token')) return Response.json({ error: 'Origin not allowed' }, { status: 403 });
  if (url.pathname.startsWith('/api/chatgpt/')) return auth.handler(request);
  if (url.pathname === '/api/status' && request.method === 'GET') {
    const session = await auth.getSession(request);
    return Response.json(ServerStatus.parse({ chatgpt: session.status === 'authenticated'
      ? { kind: 'signed_in', email: session.user?.email ?? null, plan: session.user?.plan ?? null } : { kind: 'signed_out' },
      devLlm: Boolean(config().DEV_LLM_BASE_URL), voice: Boolean(config().GRADIUM_API_KEY) }), { headers: { 'cache-control': 'no-store' } });
  }
  if (url.pathname === '/api/gradium/token' && request.method === 'GET') {
    const key = config().GRADIUM_API_KEY;
    if (!key) return Response.json({ error: 'Voice is not configured' }, { status: 503 });
    const session = await auth.getSession(request);
    if (session.status !== 'authenticated' && !config().DEV_LLM_BASE_URL) return Response.json({ error: 'Sign in with ChatGPT to use voice' }, { status: 401 });
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
    const bucket = buckets.get(ip) ?? { count: 0, resetAt: now + 60_000 };
    buckets.set(ip, bucket);
    if (++bucket.count > 30) return Response.json({ error: 'Too many voice connections' }, { status: 429, headers: { 'retry-after': '60' } });
    try {
      const upstream = await fetch('https://api.gradium.ai/api/api-keys/token', { headers: { 'x-api-key': key }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]) });
      if (!upstream.ok) throw new Error('Gradium token request failed');
      return Response.json(Token.parse(await upstream.json()), { headers: { 'cache-control': 'no-store' } });
    } catch { log('gradium_token_failed'); return Response.json({ error: 'Could not connect to Gradium' }, { status: 502 }); }
  }
  if (url.pathname === '/api/agent' && request.method === 'POST') {
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
              emit({ type: 'error', message: error instanceof Error && error.message === 'Sign in with ChatGPT to start' ? error.message : 'Could not complete that turn. Please try again.' });
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
if (import.meta.main) {
  const server = Bun.serve({ hostname: config().API_HOST, port: config().API_PORT, idleTimeout: 120, fetch: (request, server) => handleRequest(request, server.requestIP(request)?.address),
    error() { log('request_failed'); return Response.json({ error: 'Internal server error' }, { status: 500 }); },
  });
  log('server_started', { port: server.port ?? config().API_PORT });
}
