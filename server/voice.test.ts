import { expect, test } from 'bun:test';
import { PCMResampler, encodePCM, decodePCM, toBase64, fromBase64 } from '../src/voice/pcm';
import { TurnDetector } from '../src/voice/turn-detector';
import { WordBuffer } from '../src/voice/tts';
test('PCM encoding clamps signed little-endian samples', () => {
  expect([...encodePCM(Float32Array.from([-2, -1, 0, 1, 2]))]).toEqual([0,128,0,128,0,0,255,127,255,127]);
  expect([...decodePCM(Uint8Array.from([0,128,0,0]))]).toEqual([-1,0]);
  expect([...fromBase64(toBase64(Uint8Array.from([0,128,255]))) ]).toEqual([0,128,255]);
});
test('48k resampling preserves 80ms frame timing across arbitrary capture blocks', () => {
  const resampler = new PCMResampler(48000); const frames = [];
  for (let offset = 0; offset < 7680; offset += 128) frames.push(...resampler.push(new Float32Array(128).fill(0.5)));
  expect(frames.length).toBe(2); expect(frames[0]?.length).toBe(3840);
  expect(decodePCM(frames[0] ?? new Uint8Array())[0]).toBeCloseTo(0.5, 4);
});
test('44.1k resampling retains phase across non-integral block boundaries', () => {
  const resampler = new PCMResampler(44100); const frames = [];
  for (let offset = 0; offset < 7056; offset += 63) frames.push(...resampler.push(new Float32Array(63).fill(-0.25)));
  expect(frames.length).toBe(2); expect(decodePCM(frames[1] ?? new Uint8Array())[1919]).toBeCloseTo(-0.25, 4);
});
test('semantic turn detector requires text and sustained inactivity; barge-in requires 320ms activity', () => {
  const detector = new TurnDetector();
  for (let i = 0; i < 10; i++) expect(detector.step(0.99).endTurn).toBe(false);
  detector.reset(); detector.addText('Build a tracker');
  expect(detector.step(0.9).endTurn).toBe(false); expect(detector.step(0.9).endTurn).toBe(false);
  expect(detector.step(0.9).endTurn).toBe(true); expect(detector.take()).toBe('Build a tracker');
  for (let i = 0; i < 4; i++) expect(detector.step(0.1).bargeIn).toBe(false);
  detector.reset(); detector.addText('Wait');
  for (let i = 0; i < 3; i++) expect(detector.step(0.1).bargeIn).toBe(false);
  expect(detector.step(0.1).bargeIn).toBe(true);
});
test('TTS buffers subwords and keeps punctuation attached', () => {
  const words = new WordBuffer();
  expect(words.push('Hel')).toBe(''); expect(words.push('lo')).toBe(''); expect(words.push(', world')).toBe('Hello,');
  expect(words.push('! ')).toBe('world!'); expect(words.finish()).toBe('');
});

test('word buffer releases a sentence-final word without waiting for a trailing space', () => {
  const words = new WordBuffer();
  expect(words.push('or friendly')).toBe('or');
  expect(words.push(' accountability?')).toBe('friendly accountability?');
  expect(words.finish()).toBe('');
});

for (const mode of ['healthy', 'rapid']) {
  test(`STT reconnect budget ${mode === 'healthy' ? 'resets after stable audio' : 'bounds rapid failures'}`, async () => {
    const child = Bun.spawn(['bun', 'server/fixtures/stt-reconnect.ts', mode], { stdout: 'pipe', stderr: 'pipe' });
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(error).toBe(''); expect(exit).toBe(0);
  }, 10000);
}
