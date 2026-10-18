import { expect, test } from 'bun:test';
import { PhraseChunker } from '../src/voice/phrase-chunker';

test('punctuation at segment end commits once; turn end commits short unpunctuated requests', () => {
  for (const punctuation of ['.', '?', '!']) {
    const phrases: string[] = []; let partial = '';
    const chunker = new PhraseChunker({ onPhrase: text => phrases.push(text), onPartial: text => { partial = text; } });
    chunker.addText(`habit tracker${punctuation}`); expect(phrases).toEqual([]);
    chunker.endSegment(); expect(phrases).toEqual([`habit tracker${punctuation}`]); expect(partial).toBe('');
    chunker.endTurn(); expect(phrases).toHaveLength(1);
    chunker.addText('with streaks'); chunker.endTurn(); expect(phrases.at(-1)).toBe('with streaks');
    chunker.addText('and reminders.'); chunker.endTurn(); expect(phrases.at(-1)).toBe('and reminders.');
  }
});
test('four words commit after 250ms with no new word; further text resets timer', async () => {
  const phrases: string[] = []; const chunker = new PhraseChunker({ onPhrase: text => phrases.push(text), onPartial() {} });
  chunker.addText('one two three'); await Bun.sleep(280); expect(phrases).toHaveLength(0);
  chunker.addText('four'); await Bun.sleep(200); chunker.addText('five'); await Bun.sleep(200); expect(phrases).toHaveLength(0);
  await Bun.sleep(80); expect(phrases).toEqual(['one two three four five']); chunker.reset();
});
test('semantic pause retains fragments and reset cancels pending text/timer', async () => {
  const phrases: string[] = []; const chunker = new PhraseChunker({ onPhrase: text => phrases.push(text), onPartial() {} });
  chunker.addText('with streaks'); chunker.pause(); expect(phrases).toEqual([]);
  chunker.addText('one two three four five six'); chunker.reset(); await Bun.sleep(380); chunker.endTurn(); expect(phrases).toHaveLength(0);
});
test('continuous speech commits within 1.6 seconds without an inter-word pause', async () => {
  const phrases: string[] = [];
  const chunker = new PhraseChunker({ onPhrase: text => phrases.push(text), onPartial() {} });
  for (const word of ['Cat', 'Simulator', 'is', 'a', 'Roblox', 'game', 'with', 'cats', 'and']) { chunker.addText(word); await Bun.sleep(200); }
  expect(phrases.length).toBeGreaterThan(0); expect(phrases[0]).toContain('Cat Simulator is a Roblox game'); chunker.reset();
});
