// Reads pixel dimensions from a PNG or JPEG data URL synchronously, so images can be laid out
// before the browser decodes them. Returns null for anything it cannot parse.

export type ImageMime = "image/png" | "image/jpeg";

export function mimeOf(dataUrl: string): ImageMime | null {
  if (dataUrl.startsWith("data:image/png")) return "image/png";
  if (dataUrl.startsWith("data:image/jpeg") || dataUrl.startsWith("data:image/jpg")) return "image/jpeg";
  return null;
}

function bytesOf(dataUrl: string, maxBytes: number): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !dataUrl.slice(0, comma).includes(";base64")) return null;
  // 4 base64 chars encode 3 bytes; decode only the head we need.
  const chunk = dataUrl.slice(comma + 1, comma + 1 + Math.ceil(maxBytes / 3) * 4);
  try {
    const binary = atob(chunk);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function readImageSize(dataUrl: string): { width: number; height: number } | null {
  const mime = mimeOf(dataUrl);
  if (mime === "image/png") {
    const b = bytesOf(dataUrl, 32);
    if (b === null || b.length < 24) return null;
    const view = new DataView(b.buffer);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === "image/jpeg") {
    const b = bytesOf(dataUrl, 256 * 1024);
    if (b === null) return null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1] ?? 0;
      const length = ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = ((b[i + 5] ?? 0) << 8) | (b[i + 6] ?? 0);
        const width = ((b[i + 7] ?? 0) << 8) | (b[i + 8] ?? 0);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += 2 + length;
    }
  }
  return null;
}
