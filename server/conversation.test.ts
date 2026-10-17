import { expect, test } from 'bun:test';
test('microphone readiness preserves an active typed turn and assistant playback', async () => {
  const child = Bun.spawn(['bun', 'server/fixtures/conversation-startup.ts'], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(''); expect(exit).toBe(0);
}, 5000);
