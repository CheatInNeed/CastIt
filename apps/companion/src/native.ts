// Chrome native messaging framing: each message is a 32-bit length in native byte order
// (little-endian on every platform Chrome supports) followed by that many bytes of UTF-8 JSON.

/** Chrome refuses messages from a host larger than 1 MB. */
const MAX_OUTGOING = 1024 * 1024;
/** Messages from the extension are small; anything bigger is a framing error. */
const MAX_INCOMING = 4 * 1024 * 1024;

export function encodeNative(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_OUTGOING) throw new Error('Message too large for native messaging.');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/** Splits stdin into parsed messages. */
export class NativeReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32LE(0);
      if (len > MAX_INCOMING) throw new Error('Native message too large.');
      if (this.buffer.length < 4 + len) break;
      messages.push(JSON.parse(this.buffer.toString('utf8', 4, 4 + len)));
      this.buffer = this.buffer.subarray(4 + len);
    }
    return messages;
  }
}
