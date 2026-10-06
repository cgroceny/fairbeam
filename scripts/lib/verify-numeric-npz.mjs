import { createHash } from 'node:crypto';
import { endianness } from 'node:os';

const MAX_ENTRIES = 256;
const MAX_ARRAY_BYTES = 64 * 1024 * 1024;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`numeric.npz: ${message}`);
}

function requireThat(condition, message) {
  if (!condition) fail(message);
}

function bounds(buffer, offset, length, limit = buffer.length) {
  requireThat(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 &&
    offset <= limit && length <= limit - offset, 'field exceeds available bytes');
}

function uint64(buffer, offset, limit) {
  bounds(buffer, offset, 8, limit);
  const value = buffer.readBigUInt64LE(offset);
  requireThat(value <= BigInt(Number.MAX_SAFE_INTEGER), 'ZIP64 value exceeds safe integer range');
  return Number(value);
}

function findEocd(buffer) {
  requireThat(Buffer.isBuffer(buffer), 'input must be a Buffer');
  requireThat(buffer.length >= 22, 'truncated end-of-central-directory record');
  const first = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_EOCD) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  fail('end-of-central-directory record not found');
}

function parseExtraFields(buffer, start, length, limit) {
  bounds(buffer, start, length, limit);
  const fields = new Map();
  let offset = start;
  const end = start + length;
  while (offset < end) {
    bounds(buffer, offset, 4, end);
    const id = buffer.readUInt16LE(offset);
    const size = buffer.readUInt16LE(offset + 2);
    offset += 4;
    bounds(buffer, offset, size, end);
    requireThat(!fields.has(id), 'duplicate ZIP extra field');
    fields.set(id, buffer.subarray(offset, offset + size));
    offset += size;
  }
  requireThat(offset === end, 'malformed ZIP extra field lengths');
  return fields;
}

function parseZip64Values(extraFields, needs, label) {
  const field = extraFields.get(0x0001);
  requireThat(field, `${label} is missing ZIP64 size/offset values`);
  let offset = 0;
  const result = {};
  for (const [name, required] of needs) {
    if (!required) continue;
    const width = name === 'diskStart' ? 4 : 8;
    bounds(field, offset, width);
    result[name] = width === 4 ? field.readUInt32LE(offset) : uint64(field, offset, field.length);
    offset += width;
  }
  return result;
}

function readName(buffer, offset, length, limit) {
  bounds(buffer, offset, length, limit);
  const bytes = buffer.subarray(offset, offset + length);
  for (const byte of bytes) requireThat(byte < 0x80, 'non-ASCII ZIP entry name is unsupported');
  return bytes.toString('ascii');
}

function parseCentralDirectory(buffer) {
  const eocdOffset = findEocd(buffer);
  const disk = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  requireThat(disk === 0 && centralDisk === 0 && diskEntries === totalEntries, 'multi-disk ZIP files are unsupported');
  requireThat(diskEntries !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff,
    'ZIP64 end-of-central-directory records are unsupported');
  requireThat(totalEntries > 0 && totalEntries <= MAX_ENTRIES, 'unexpected ZIP entry count');
  requireThat(centralOffset + centralSize === eocdOffset, 'central directory bounds do not match end record');
  bounds(buffer, centralOffset, centralSize, eocdOffset);

  const entries = [];
  let offset = centralOffset;
  const end = centralOffset + centralSize;
  for (let index = 0; index < totalEntries; index += 1) {
    bounds(buffer, offset, 46, end);
    requireThat(buffer.readUInt32LE(offset) === ZIP_CENTRAL, 'bad central directory signature');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressed32 = buffer.readUInt32LE(offset + 20);
    const uncompressed32 = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const diskStart16 = buffer.readUInt16LE(offset + 34);
    const localOffset32 = buffer.readUInt32LE(offset + 42);
    const variableStart = offset + 46;
    bounds(buffer, variableStart, nameLength + extraLength + commentLength, end);
    const name = readName(buffer, variableStart, nameLength, end);
    const extraStart = variableStart + nameLength;
    const extras = parseExtraFields(buffer, extraStart, extraLength, end);

    let compressedSize = compressed32;
    let uncompressedSize = uncompressed32;
    let localOffset = localOffset32;
    let diskStart = diskStart16;
    const needUncompressed = uncompressed32 === 0xffffffff;
    const needCompressed = compressed32 === 0xffffffff;
    const needOffset = localOffset32 === 0xffffffff;
    const needDisk = diskStart16 === 0xffff;
    if (needUncompressed || needCompressed || needOffset || needDisk) {
      const wide = parseZip64Values(extras, [
        ['uncompressedSize', needUncompressed], ['compressedSize', needCompressed],
        ['localOffset', needOffset], ['diskStart', needDisk]
      ], `central entry ${name}`);
      if (needUncompressed) uncompressedSize = wide.uncompressedSize;
      if (needCompressed) compressedSize = wide.compressedSize;
      if (needOffset) localOffset = wide.localOffset;
      if (needDisk) diskStart = wide.diskStart;
    }
    requireThat(diskStart === 0, 'multi-disk ZIP entry is unsupported');
    requireThat(method === 0, `compressed ZIP entry is unsupported: ${name}`);
    requireThat((flags & ~0x0800) === 0, `unsupported ZIP flags on ${name}`);
    requireThat(compressedSize === uncompressedSize, `stored entry has inconsistent sizes: ${name}`);
    requireThat(uncompressedSize <= MAX_ARRAY_BYTES, `array entry is too large: ${name}`);
    entries.push({ name, flags, method, crc32, compressedSize, uncompressedSize, localOffset });
    offset = variableStart + nameLength + extraLength + commentLength;
  }
  requireThat(offset === end, 'unexpected data after central directory entries');
  return { entries, centralOffset };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readStoredEntry(buffer, entry, centralOffset) {
  const offset = entry.localOffset;
  bounds(buffer, offset, 30, centralOffset);
  requireThat(buffer.readUInt32LE(offset) === ZIP_LOCAL, `bad local header signature: ${entry.name}`);
  const flags = buffer.readUInt16LE(offset + 6);
  const method = buffer.readUInt16LE(offset + 8);
  const localCrc = buffer.readUInt32LE(offset + 14);
  const compressed32 = buffer.readUInt32LE(offset + 18);
  const uncompressed32 = buffer.readUInt32LE(offset + 22);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  requireThat(flags === entry.flags && method === entry.method, `local/central header disagreement: ${entry.name}`);
  const variableStart = offset + 30;
  bounds(buffer, variableStart, nameLength + extraLength, centralOffset);
  const localName = readName(buffer, variableStart, nameLength, centralOffset);
  requireThat(localName === entry.name, `local/central filename mismatch: ${entry.name}`);
  const extras = parseExtraFields(buffer, variableStart + nameLength, extraLength, centralOffset);

  let compressedSize = compressed32;
  let uncompressedSize = uncompressed32;
  if (compressed32 === 0xffffffff || uncompressed32 === 0xffffffff) {
    const wide = parseZip64Values(extras, [
      ['uncompressedSize', uncompressed32 === 0xffffffff], ['compressedSize', compressed32 === 0xffffffff]
    ], `local entry ${entry.name}`);
    if (uncompressed32 === 0xffffffff) uncompressedSize = wide.uncompressedSize;
    if (compressed32 === 0xffffffff) compressedSize = wide.compressedSize;
  }
  requireThat(compressedSize === entry.compressedSize && uncompressedSize === entry.uncompressedSize,
    `local/central size mismatch: ${entry.name}`);
  requireThat(localCrc === entry.crc32, `local/central CRC mismatch: ${entry.name}`);
  const dataOffset = variableStart + nameLength + extraLength;
  bounds(buffer, dataOffset, entry.compressedSize, centralOffset);
  const data = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
  requireThat(crc32(data) === entry.crc32, `CRC mismatch: ${entry.name}`);
  return { data, endOffset: dataOffset + entry.compressedSize };
}

function parseNpy(buffer, name) {
  requireThat(buffer.length >= 10 && buffer[0] === 0x93 && buffer.toString('ascii', 1, 6) === 'NUMPY',
    `invalid NPY magic: ${name}`);
  const major = buffer[6];
  const minor = buffer[7];
  let headerLength;
  let headerStart;
  if (major === 1 && minor === 0) {
    headerLength = buffer.readUInt16LE(8);
    headerStart = 10;
  } else if ((major === 2 || major === 3) && minor === 0) {
    requireThat(buffer.length >= 12, `truncated NPY v${major} header: ${name}`);
    headerLength = buffer.readUInt32LE(8);
    headerStart = 12;
  } else {
    fail(`unsupported NPY version ${major}.${minor}: ${name}`);
  }
  requireThat(headerLength > 0 && headerLength <= 1024 * 1024, `invalid NPY header length: ${name}`);
  bounds(buffer, headerStart, headerLength);
  const headerBytes = buffer.subarray(headerStart, headerStart + headerLength);
  const header = headerBytes.toString(major === 3 ? 'utf8' : 'ascii');
  requireThat(header.endsWith('\n'), `NPY header lacks final newline: ${name}`);
  for (const key of ['descr', 'fortran_order', 'shape']) {
    const occurrences = header.match(new RegExp(`(?:'${key}'|"${key}")\\s*:`, 'g')) ?? [];
    requireThat(occurrences.length === 1, `NPY header must contain one ${key} field: ${name}`);
  }
  const descriptor = header.match(/(?:'descr'|"descr")\s*:\s*['"]([^'"]+)['"]/);
  const fortranMatch = header.match(/(?:'fortran_order'|"fortran_order")\s*:\s*(True|False)\b/);
  const shapeMatch = header.match(/(?:'shape'|"shape")\s*:\s*\(([^)]*)\)/);
  requireThat(descriptor && fortranMatch && shapeMatch, `incomplete NPY header: ${name}`);

  const dtypeMatch = descriptor[1].match(/^([<>=|])([fc])(4|8|16)$/);
  requireThat(dtypeMatch, `unsupported NPY dtype ${descriptor[1]}: ${name}`);
  const [, byteOrder, kind, widthText] = dtypeMatch;
  const width = Number(widthText);
  requireThat((kind === 'f' && (width === 4 || width === 8)) || (kind === 'c' && width === 16),
    `unsupported NPY numeric type ${descriptor[1]}: ${name}`);
  const dtype = kind === 'c' ? 'complex128' : `float${width * 8}`;
  requireThat(byteOrder !== '|' || width === 1, `invalid byte order for multibyte NPY dtype: ${name}`);
  const littleEndian = byteOrder === '<' || (byteOrder === '=' && endianness() === 'LE') || byteOrder === '|';
  const fortranOrder = fortranMatch[1] === 'True';
  const dimensions = shapeMatch[1].trim();
  const shapeParts = dimensions === '' ? [] : dimensions.split(',');
  if (shapeParts.at(-1)?.trim() === '') shapeParts.pop();
  requireThat(shapeParts.every((part) => part.trim() !== ''), `invalid NPY shape: ${name}`);
  const shape = shapeParts.map((part) => {
    const value = part.trim();
    requireThat(/^\d+$/.test(value), `invalid NPY shape: ${name}`);
    const dimension = Number(value);
    requireThat(Number.isSafeInteger(dimension), `NPY shape exceeds safe integer range: ${name}`);
    return dimension;
  }).filter((value, index, values) => !(value === undefined && index === values.length - 1));
  const count = shape.reduce((product, dimension) => {
    const next = product * dimension;
    requireThat(Number.isSafeInteger(next), `NPY element count exceeds safe integer range: ${name}`);
    return next;
  }, 1);
  const itemSize = kind === 'c' ? 16 : width;
  const byteLength = count * itemSize;
  requireThat(Number.isSafeInteger(byteLength) && byteLength <= MAX_ARRAY_BYTES, `NPY array is too large: ${name}`);
  const dataOffset = headerStart + headerLength;
  requireThat(dataOffset + byteLength === buffer.length, `NPY data length does not match shape: ${name}`);
  return { dtype, shape, count, kind, width, itemSize, littleEndian, fortranOrder, data: buffer.subarray(dataOffset) };
}

function cOrderBytes(array, name) {
  if (!array.fortranOrder || array.count <= 1 || array.shape.length <= 1) return Buffer.from(array.data);
  const output = Buffer.allocUnsafe(array.data.length);
  const coordinates = new Array(array.shape.length);
  for (let cIndex = 0; cIndex < array.count; cIndex += 1) {
    let remaining = cIndex;
    for (let axis = array.shape.length - 1; axis >= 0; axis -= 1) {
      const dimension = array.shape[axis];
      requireThat(dimension > 0, `cannot index empty Fortran-order array: ${name}`);
      coordinates[axis] = remaining % dimension;
      remaining = Math.floor(remaining / dimension);
    }
    let fIndex = 0;
    let stride = 1;
    for (let axis = 0; axis < array.shape.length; axis += 1) {
      fIndex += coordinates[axis] * stride;
      stride *= array.shape[axis];
    }
    array.data.copy(output, cIndex * array.itemSize, fIndex * array.itemSize, (fIndex + 1) * array.itemSize);
  }
  return output;
}

function decodeArray(array, cBytes, name) {
  const components = array.kind === 'c' ? 2 : 1;
  const result = array.width === 4 && array.kind === 'f'
    ? new Float32Array(array.count)
    : new Float64Array(array.count * components);
  const read = array.kind === 'c' || array.width === 8 ?
    (offset) => array.littleEndian ? cBytes.readDoubleLE(offset) : cBytes.readDoubleBE(offset) :
    (offset) => array.littleEndian ? cBytes.readFloatLE(offset) : cBytes.readFloatBE(offset);
  const componentSize = array.kind === 'c' ? 8 : array.width;
  for (let element = 0; element < array.count; element += 1) {
    for (let component = 0; component < components; component += 1) {
      const value = read(element * array.itemSize + component * componentSize);
      requireThat(Number.isFinite(value), `nonfinite numeric value in ${name}`);
      result[element * components + component] = value;
    }
  }
  return result;
}

/**
 * Verify a stored NPZ's complete numeric signature map and decode its arrays.
 * Complex arrays expose interleaved real/imaginary values in Float64Array.
 */
export function verifyNumericNpz(buffer, expectedSignatures) {
  requireThat(Buffer.isBuffer(buffer), 'input must be a Buffer');
  requireThat(expectedSignatures && typeof expectedSignatures === 'object' && !Array.isArray(expectedSignatures),
    'expected signatures must be a name-to-signature object');
  const expectedNames = Object.keys(expectedSignatures);
  requireThat(expectedNames.length > 0 && expectedNames.includes('frequency_Hz') && expectedNames.includes('s11'),
    'frequency_Hz and s11 signatures are required');
  for (const key of expectedNames) {
    const expected = expectedSignatures[key];
    requireThat(expected && HASH_PATTERN.test(expected.sha256) && Array.isArray(expected.shape) &&
      expected.shape.every((dimension) => Number.isSafeInteger(dimension) && dimension >= 0) &&
      ['float32', 'float64', 'complex128'].includes(expected.dtype), `invalid expected signature for ${key}`);
  }

  const { entries, centralOffset } = parseCentralDirectory(buffer);
  const names = new Set();
  const ranges = [];
  const signatures = {};
  const arrays = {};
  let totalBytes = 0;
  for (const entry of entries) {
    requireThat(entry.name.endsWith('.npy'), `unexpected non-NPY entry: ${entry.name}`);
    const name = entry.name.slice(0, -4);
    requireThat(Object.hasOwn(expectedSignatures, name), `unexpected array entry: ${name}`);
    requireThat(!names.has(name), `duplicate array entry: ${name}`);
    names.add(name);
    totalBytes += entry.uncompressedSize;
    requireThat(Number.isSafeInteger(totalBytes) && totalBytes <= MAX_ARRAY_BYTES, 'total array bytes exceed limit');
    const local = readStoredEntry(buffer, entry, centralOffset);
    ranges.push([entry.localOffset, local.endOffset, entry.name]);
    const array = parseNpy(local.data, name);
    const expected = expectedSignatures[name];
    requireThat(array.dtype === expected.dtype, `dtype mismatch for ${name}`);
    requireThat(stableShape(array.shape, expected.shape), `shape mismatch for ${name}`);
    const bytes = cOrderBytes(array, name);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    requireThat(sha256 === expected.sha256, `SHA-256 mismatch for ${name}`);
    signatures[name] = { sha256, dtype: array.dtype, shape: array.shape };
    arrays[name] = { dtype: array.dtype, shape: array.shape, values: decodeArray(array, bytes, name) };
  }
  requireThat(names.size === expectedNames.length && expectedNames.every((name) => names.has(name)),
    'missing expected numeric array');
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.length) {
    requireThat(ranges[0][0] === 0, 'unexpected bytes before first ZIP entry');
    for (let index = 1; index < ranges.length; index += 1) {
      requireThat(ranges[index - 1][1] === ranges[index][0], 'unexpected gap between ZIP entries');
    }
    requireThat(ranges.at(-1)[1] === centralOffset, 'unexpected bytes before central directory');
  }
  for (let index = 1; index < ranges.length; index += 1) {
    requireThat(ranges[index - 1][1] <= ranges[index][0], `overlapping ZIP entries: ${ranges[index - 1][2]} and ${ranges[index][2]}`);
  }
  return { signatures, arrays };
}

function stableShape(actual, expected) {
  return actual.length === expected.length && actual.every((dimension, index) => dimension === expected[index]);
}
