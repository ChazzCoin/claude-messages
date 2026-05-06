/**
 * Modern macOS stores message bodies in `attributedBody` (a serialized
 * NSAttributedString in Apple's typedstream format) rather than the
 * `text` column. Full decode is non-trivial — for V0 we run a naive
 * extractor that grabs the plain-text run that follows the NSString
 * class marker. Works for most simple messages; misses formatting,
 * URL attribution, and reactions metadata.
 *
 * Swap target: shell out to `imessage-exporter` (Rust) or use a real
 * typedstream decoder library when V1 step 2 needs full fidelity.
 */
export function decodeAttributedBody(buf: Buffer | Uint8Array | null | undefined): string | null {
  if (!buf || buf.length === 0) return null;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

  // Find the "NSString" marker. The text usually appears shortly after,
  // prefixed by a length byte (or short varint) and run as UTF-8.
  const marker = Buffer.from('NSString', 'utf-8');
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idx = haystack.indexOf(marker);
  if (idx < 0) return null;

  // Skip past the class chain header. The byte sequence after NSString
  // is typically: 01 94 84 01 2B [len_byte_or_varint] [utf8 bytes]
  let cursor = idx + marker.length;
  // Walk forward looking for the '+' (0x2B) that marks the start of
  // the string-data field.
  const plus = haystack.indexOf(0x2b, cursor);
  if (plus < 0 || plus > cursor + 16) return null;
  cursor = plus + 1;

  // Parse length. Apple uses a one-byte length unless 0x81 (extended).
  let length: number;
  if (cursor >= haystack.length) return null;
  const lenByte = haystack[cursor]!;
  if (lenByte === 0x81) {
    if (cursor + 2 >= haystack.length) return null;
    length = haystack.readUInt16LE(cursor + 1);
    cursor += 3;
  } else if (lenByte === 0x82) {
    if (cursor + 4 >= haystack.length) return null;
    length = haystack.readUInt32LE(cursor + 1);
    cursor += 5;
  } else {
    length = lenByte;
    cursor += 1;
  }

  if (length <= 0 || cursor + length > haystack.length) return null;
  const text = haystack.subarray(cursor, cursor + length).toString('utf-8');
  // Sanity: throw out anything with too many control chars (decoder miss).
  // eslint-disable-next-line no-control-regex
  const controlRatio = (text.match(/[\x00-\x08\x0E-\x1F]/g)?.length ?? 0) / Math.max(1, text.length);
  if (controlRatio > 0.1) return null;
  return text;
}

/**
 * Resolve the displayable text for a message row, preferring the
 * `text` column when present and falling back to a decoded
 * `attributedBody`. Returns `null` if neither yields a usable string.
 */
export function resolveMessageText(
  text: string | null | undefined,
  attributedBody: Buffer | Uint8Array | null | undefined,
): string | null {
  if (text && text.length > 0) return text;
  return decodeAttributedBody(attributedBody);
}
