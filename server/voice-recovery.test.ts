import { expect, test } from 'bun:test';
for (const fixture of ['stt-recovery', 'agent-timeout', 'queue-timeout', 'microphone-ended']) test(`${fixture} recovers from a stalled dependency without losing later work`, async () => {
  const child = Bun.spawn(['bun', `server/fixtures/${fixture}.ts`], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(''); expect(exit).toBe(0);
}, 5000);
