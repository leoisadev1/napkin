import { handleRequest } from './index';
import { parseAgentStream } from '../src/agent/client';
const started = performance.now(); let pending = false; let image = false; let done = false;
const response = await handleRequest(new Request('http://smoke/api/agent', { method: 'POST', signal: AbortSignal.timeout(90000), body: JSON.stringify({ mode: 'turn', utterance: 'Generate one concept image of Cat Simulator, a playful Roblox cat adventure, colourful low-poly islands. Use the image command.', history: [], board: { title: 'Cat Simulator', items: [], selection: [], pointer: null, viewport: { x: 0, y: 0, w: 1200, h: 800 } } }) }));
if (!response.body) throw new Error('No response body');
for await (const event of parseAgentStream(response.body)) {
  if (event.type === 'error') throw new Error(event.message);
  if (event.type === 'pending') pending = true;
  if (event.type === 'pending_done') done = true;
  if (event.type === 'op' && event.op.op === 'add_image') {
    if (!pending) throw new Error('Image arrived without pending');
    const bytes = Buffer.from(event.op.dataUrl.split(',')[1] ?? '', 'base64');
    if (bytes.length < 1000) throw new Error('Empty image');
    await Bun.write('/tmp/rtw-cat-concept.png', bytes); image = true;
  }
}
process.stdout.write(`${JSON.stringify({ pending, image, pendingDone: done, ms: Math.round(performance.now() - started) })}\n`);
if (!pending || !image || !done) throw new Error('Image lifecycle incomplete');
