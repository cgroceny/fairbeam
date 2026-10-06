// WOFF 1.0 -> TrueType (sfnt) conversion, so jsPDF can embed IBM Plex Sans (it needs TTF data).
// Pure: runs in the browser and in Node.

// fflate is imported on demand so it stays out of the startup bundle.

export async function woffToTtf(woff: Uint8Array): Promise<Uint8Array> {
  const { unzlibSync } = await import("fflate");
  const dv = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (dv.getUint32(0) !== 0x774f4646) throw new Error("not a WOFF 1.0 file");
  const flavor = dv.getUint32(4);
  const numTables = dv.getUint16(12);
  const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const e = 44 + i * 20;
    const tag = dv.getUint32(e);
    const offset = dv.getUint32(e + 4);
    const compLength = dv.getUint32(e + 8);
    const origLength = dv.getUint32(e + 12);
    const checksum = dv.getUint32(e + 16);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? unzlibSync(raw) : raw;
    if (data.length !== origLength) throw new Error("WOFF table length mismatch");
    tables.push({ tag, checksum, data });
  }
  const headerLen = 12 + numTables * 16;
  const pad4 = (n: number) => (n + 3) & ~3;
  const total = tables.reduce((s, t) => s + pad4(t.data.length), headerLen);
  const out = new Uint8Array(total);
  const o = new DataView(out.buffer);
  let es = 0;
  while (1 << (es + 1) <= numTables) es++;
  const searchRange = (1 << es) * 16;
  o.setUint32(0, flavor);
  o.setUint16(4, numTables);
  o.setUint16(6, searchRange);
  o.setUint16(8, es);
  o.setUint16(10, numTables * 16 - searchRange);
  let offset = headerLen;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    o.setUint32(r, t.tag);
    o.setUint32(r + 4, t.checksum);
    o.setUint32(r + 8, offset);
    o.setUint32(r + 12, t.data.length);
    out.set(t.data, offset);
    offset += pad4(t.data.length);
  });
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
