import { z } from 'zod';

// The installed 0.2.0 package predates its documented images API. This small
// compatibility client uses the same authenticated Responses image tool.
const Image = z.object({ type: z.literal('image_generation_call'), result: z.string().min(1) });
const ImageEvent = z.object({
  type: z.string(), item: z.unknown().optional(),
  response: z.object({ output: z.array(z.unknown()).optional() }).optional(),
});
export function imageClient(proxyFetch: typeof fetch) {
  return { async generate(options: { prompt: string; model: string; quality: 'low'; size: string; format: 'png'; signal: AbortSignal }) {
    const response = await proxyFetch('/api/chatgpt/responses', {
      method: 'POST', signal: options.signal,
      headers: { 'content-type': 'application/json', 'x-login-with-chatgpt-reasoning-effort': 'low', 'x-login-with-chatgpt-service-tier': 'default' },
      body: JSON.stringify({ model: options.model, input: options.prompt, stream: true,
        tools: [{ type: 'image_generation', action: 'generate', size: options.size, quality: options.quality, output_format: options.format }],
        tool_choice: { type: 'image_generation' },
      }),
    });
    if (!response.ok || !response.body) throw new Error('ChatGPT image request failed');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: string | undefined;
    const consume = (block: string) => {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') return;
      const event = ImageEvent.parse(JSON.parse(data));
      if (event.type === 'error' || event.type === 'response.failed') throw new Error('ChatGPT image generation failed');
      for (const value of [event.item, ...(event.response?.output ?? [])]) {
        const image = Image.safeParse(value);
        if (image.success) result = image.data.result;
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() ?? '';
        for (const block of blocks) consume(block);
        if (done) break;
      }
      if (buffer.trim()) consume(buffer);
    } finally { await reader.cancel(); reader.releaseLock(); }
    if (!result) throw new Error('ChatGPT returned no image');
    return { data: [{ dataUrl: `data:image/png;base64,${result}` }] };
  } };
}
