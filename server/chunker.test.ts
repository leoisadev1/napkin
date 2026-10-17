import { expect, test } from 'bun:test';
import { PhraseChunker } from '../src/voice/phrase-chunker';

test('punctuation at segment end commits once; turn end flushes only remainder', () => {
  for (const punctuation of [',', '.', '?', '!', ';', ':']) {
    const phrases: string[] = []; let partial = '';
    const chunker = new PhraseChunker({ onPhrase: text => phrases.push(text), onPartial: text => { partial = text; } });
    chunker.addText(`habit tracker${punctuation}`); expect(phrases).toEqual([]);
    chunker.endSegment(); expect(phrases).toEqual([`habit tracker${punctuation}`]); expect(partial).toBe('');
    chunker.endTurn(); expect(phrases).toHaveLength(1);
    chunker.addText('with streaks'); chunker.endTurn(); expect(phrases.at(-1)).toBe('with streaks');
  }
});
test('six words commit after 350ms with no new word; further text resets timer', async () => {
  const phrases: string[] = []; const chunker = new PhraseChunker({ onPhrase: text => phrases.push(text), onPartial() {} });
  chunker.addText('one two three four five'); await Bun.sleep(380); expect(phrases).toHaveLength(0);
  chunker.addText('six'); await Bun.sleep(200); chunker.addText('seven'); await Bun.sleep(200); expect(phrases).toHaveLength(0);
  await Bun.sleep(180); expect(phrases).toEqual(['one two three four five six seven']); chunker.reset();
});
test('semantic pause commits short phrases and reset cancels pending text/timer', async () => {
  const phrases: string[] = []; const chunker = new PhraseChunker({ onPhrase: text => phrases.push(text), onPartial() {} });
  chunker.addText('with streaks'); chunker.pause(); expect(phrases).toEqual(['with streaks']);
  chunker.addText('one two three four five six'); chunker.reset(); await Bun.sleep(380); chunker.endTurn(); expect(phrases).toHaveLength(1);
});
