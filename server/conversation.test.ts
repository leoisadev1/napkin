import { expect, test } from 'bun:test';
test('microphone readiness preserves drawing and listening', async () => {
  const child = Bun.spawn(['bun', 'server/fixtures/conversation-startup.ts'], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(''); expect(exit).toBe(0);
}, 5000);

for (const failure of ['stt', 'connect', 'agent']) {
  test(`Retry voice replaces the old session after ${failure} failure`, async () => {
    const child = Bun.spawn(['bun', 'server/fixtures/conversation-retry.ts', failure], { stdout: 'pipe', stderr: 'pipe' });
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(error).toBe(''); expect(exit).toBe(0);
  }, 5000);
}

test('live speech serializes and coalesces drawing, preserves listening, supports pause suggestions, cancellation and chips without TTS', async () => {
  const child = Bun.spawn(['bun', 'server/fixtures/live-engine.ts'], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(''); expect(exit).toBe(0);
}, 10000);
test('refine carries stretch context, runs beside chips, buffers all ops and cancels on new speech', async () => {
  const child = Bun.spawn(['bun', 'server/fixtures/refine-engine.ts'], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(''); expect(exit).toBe(0);
}, 5000);
test('unsupported native 24kHz microphone capture falls back to the device rate', async () => {
  const child = Bun.spawn(['bun', 'server/fixtures/microphone-fallback.ts'], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(''); expect(exit).toBe(0);
}, 5000);

for (const fixture of ['mute-engine', 'pipeline-engine']) test(`${fixture} exercises the public conversation API`, async () => {
  const child = Bun.spawn(['bun', `server/fixtures/${fixture}.ts`], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(''); expect(exit).toBe(0);
}, 5000);

test('a spoken question has one owner across unpunctuated speech and its continuation', async () => {
  const child = Bun.spawn(['bun', 'server/fixtures/question-engine.ts'], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).toBe(''); expect(exit).toBe(0);
}, 5000);

test('independent live drawings land before earlier streams finish without stale overwrites or missing references', async () => {
  const process = Bun.spawn(['bun', 'run', 'server/fixtures/early-drawing.ts'], { stdout: 'pipe', stderr: 'pipe' });
  const exit = await process.exited;
  const stderr = await new Response(process.stderr).text();
  expect(stderr).toBe(''); expect(exit).toBe(0);
});
