import { Writable } from 'stream'

export interface CollectingStream {
  stream: Writable
  // Everything written so far, decoded as UTF-8 once, so a character split across two
  // chunks comes out whole.
  text: () => string
}

// Collects what is written to it, for an exec's stderr. Replaces stream-buffers'
// WritableStreamBuffer, whose constructor calls the deprecated `Buffer()` (DEP0005) and
// printed a DeprecationWarning in every job log.
export function collectingStream(): CollectingStream {
  const chunks: Buffer[] = []
  // `decodeStrings` (on by default) turns written strings into Buffers before `write`.
  const stream = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      chunks.push(chunk)
      callback()
    }
  })
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') }
}
