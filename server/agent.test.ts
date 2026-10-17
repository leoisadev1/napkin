import { expect, test } from 'bun:test';
import { validateOperation } from './agent';
import { handleRequest } from './index';

test('invalid operations are rejected at the tool boundary', () => {
  expect(validateOperation({ op: 'move', id: 'missing spaces', placement: { kind: 'auto' } })).toBeUndefined();
  expect(validateOperation({ op: 'add_shape', id: 'ok', label: 'Habit', shape: 'box', color: 'green', placement: { kind: 'auto' } })).toEqual({ op: 'add_shape', id: 'ok', label: 'Habit', shape: 'box', color: 'green', placement: { kind: 'auto' } });
  expect(validateOperation({ op: 'drop_database' })).toBeUndefined();
});
test('agent endpoint rejects malformed input before streaming', async () => {
  const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', body: JSON.stringify({ utterance: '' }) }));
  expect(response.status).toBe(400);
});
test('status reports capabilities without secrets', async () => {
  const response = await handleRequest(new Request('http://test/api/status'));
  const body = await response.text();
  expect(body).toContain('"voice":'); expect(body).not.toContain('GRADIUM_API_KEY'); expect(body).not.toContain('accessToken');
});
test('session store persists encrypted-session envelopes and honors expiration', async () => {
  const { sessionStore } = await import('./auth');
  const key = `test-${crypto.randomUUID()}`;
  const value = { status: 'authenticated', tokensCipher: 'encrypted-test-value', createdAt: 1, updatedAt: 2 } satisfies import('@opencoredev/loginwithchatgpt-server').StoredSession;
  try {
    await sessionStore.set(key, value, { ttlMs: 60000 });
    expect(await sessionStore.get(key)).toEqual(value);
    await sessionStore.set(key, value, { ttlMs: -1 });
    expect(await sessionStore.get(key)).toBeUndefined();
  } finally { await sessionStore.delete(key); }
});

test('cross-origin voice token and agent requests are rejected', async () => {
  for (const route of ['agent', 'gradium/token']) {
    const response = await handleRequest(new Request(`http://test/api/${route}`, { headers: { origin: 'https://untrusted.example' } }));
    expect(response.status).toBe(403);
  }
});

test('chunked oversized input is canceled at the byte boundary', async () => {
  let pulled = 0; let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(64000)); },
    cancel() { canceled = true; },
  });
  const response = await handleRequest(new Request('http://test/api/agent', { method: 'POST', body }));
  expect(response.status).toBe(413); expect(canceled).toBe(true); expect(pulled).toBeLessThanOrEqual(6);
});
