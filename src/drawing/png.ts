// PNG resolution metadata: the pHYs chunk, so a 300 dpi drawing is placed at its size by Word, LaTeX and
// image viewers (a canvas PNG says nothing and is taken as 72 or 96 dpi). Pure bytes (Node + browser).

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let table: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

/** The chunks of a PNG: type, data and where each starts (its length field). Throws on a file that is not a PNG. */
export function pngChunks(png: Uint8Array): { type: string; data: Uint8Array; at: number; end: number; crcOk: boolean }[] {
  if (png.length < 8 || SIGNATURE.some((b, i) => png[i] !== b)) throw new Error("not a PNG file");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    if (end > png.length) throw new Error("truncated PNG chunk");
    const data = png.subarray(at + 8, at + 8 + length);
    out.push({ type, data, at, end, crcOk: crc32(png.subarray(at + 4, at + 8 + length)) === view.getUint32(at + 8 + length) });
    at = end;
    if (type === "IEND") break;
  }
  return out;
}

/** The PNG with a pHYs chunk saying `dpi` pixels per inch (stored per metre), right after IHDR; an earlier pHYs is
 *  replaced. */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  const chunks = pngChunks(png);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr || !(dpi > 0)) return png;
  const ppm = Math.round(dpi / 0.0254);
  const body = new Uint8Array([..."pHYs"].map((ch) => ch.charCodeAt(0)).concat(u32(ppm), u32(ppm), [1]));
  const chunk = new Uint8Array([...u32(9), ...body, ...u32(crc32(body))]);
  const parts: Uint8Array[] = [png.subarray(0, ihdr.end), chunk];
  for (const c of chunks) if (c.at >= ihdr.end && c.type !== "pHYs") parts.push(png.subarray(c.at, c.end));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The resolution a PNG states (pixels per inch), or null when it says none. */
export function pngDpi(png: Uint8Array): number | null {
  const phys = pngChunks(png).find((c) => c.type === "pHYs");
  if (!phys || phys.data.length !== 9 || phys.data[8] !== 1) return null;
  const view = new DataView(phys.data.buffer, phys.data.byteOffset, 9);
  return view.getUint32(0) * 0.0254;
}
