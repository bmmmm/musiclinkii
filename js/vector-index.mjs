// SPDX-License-Identifier: GPL-3.0-or-later

const HEADER_BYTES = 12;
const MAGIC = [0x4d, 0x4c, 0x56, 0x49]; // MLVI
const VERSION = 1;

export function normalizeVector(values) {
  if (!values?.length) throw new Error('Vector must be non-empty');
  const vector = Float32Array.from(values);
  let squaredLength = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('Vector values must be finite');
    squaredLength += value * value;
  }
  if (squaredLength === 0) throw new Error('Vector length must be greater than zero');
  const inverseLength = 1 / Math.sqrt(squaredLength);
  for (let index = 0; index < vector.length; index += 1) vector[index] *= inverseLength;
  return vector;
}

export function quantizeUnitVector(values) {
  const result = new Int8Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    result[index] = Math.round(Math.max(-1, Math.min(1, values[index])) * 127);
  }
  return result;
}

export function encodeQuantizedIndex(vectors) {
  if (!vectors?.length) throw new Error('Index must contain at least one vector');
  const dimension = vectors[0].length;
  if (!dimension || dimension > 0xffff) throw new Error('Vector dimension must be between 1 and 65535');
  if (vectors.some((vector) => vector.length !== dimension)) throw new Error('Every vector must have the same dimension');

  const bytes = new Uint8Array(HEADER_BYTES + vectors.length * dimension);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, dimension, true);
  view.setUint32(8, vectors.length, true);
  vectors.forEach((vector, index) => {
    bytes.set(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), HEADER_BYTES + index * dimension);
  });
  return bytes;
}

export function decodeQuantizedIndex(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER_BYTES) throw new Error('Quantized index is shorter than its header');
  if (MAGIC.some((value, index) => bytes[index] !== value)) throw new Error('Quantized index has an invalid signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== VERSION) throw new Error(`Unsupported quantized index version: ${version}`);
  const dimension = view.getUint16(6, true);
  const count = view.getUint32(8, true);
  const expectedBytes = HEADER_BYTES + dimension * count;
  if (!dimension || !count || bytes.byteLength !== expectedBytes) throw new Error('Quantized index has an invalid payload length');

  const vectors = Array.from({ length: count }, (_, index) => new Int8Array(
    bytes.buffer,
    bytes.byteOffset + HEADER_BYTES + index * dimension,
    dimension,
  ));
  return { version, dimension, count, vectors, byteLength: bytes.byteLength };
}

export async function fetchQuantizedIndex(url, fetcher = globalThis.fetch, init) {
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required');
  const response = await fetcher(url, init);
  if (!response?.ok) throw new Error(`Quantized index request failed with HTTP ${response?.status ?? 'unknown'}`);
  return decodeQuantizedIndex(await response.arrayBuffer());
}

export function rankQuantized(query, index, limit = 5) {
  if (query.length !== index.dimension) throw new Error('Query and index vector dimensions do not match');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Result limit must be a positive integer');
  const normalized = normalizeVector(query);
  const matches = index.vectors.map((vector, vectorIndex) => {
    let score = 0;
    for (let dimension = 0; dimension < vector.length; dimension += 1) {
      score += normalized[dimension] * vector[dimension] / 127;
    }
    return { index: vectorIndex, score };
  });
  matches.sort((left, right) => right.score - left.score || left.index - right.index);
  return matches.slice(0, Math.min(limit, matches.length));
}
