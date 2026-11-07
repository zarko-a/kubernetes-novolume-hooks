import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { collectingStream } from '../src/k8s/collect-stream'

describe('collectingStream', () => {
  it('is empty before anything is written', () => {
    expect(collectingStream().text()).toBe('')
  })

  it('collects buffers and strings in order', async () => {
    const collector = collectingStream()
    collector.stream.write(Buffer.from('tar: '))
    collector.stream.write('cannot open: ')
    collector.stream.write('Permission denied\n', 'utf8')
    await new Promise(resolve => collector.stream.end(resolve))
    expect(collector.text()).toBe('tar: cannot open: Permission denied\n')
  })

  it('keeps a multi-byte character split across two chunks whole', async () => {
    const bytes = Buffer.from('größe – ok', 'utf8')
    // Split inside the two-byte "ö" and the three-byte "–".
    const chunks = [
      bytes.subarray(0, 3),
      bytes.subarray(3, 9),
      bytes.subarray(9)
    ]
    const collector = collectingStream()
    await pipeline(Readable.from(chunks), collector.stream)
    expect(collector.text()).toBe('größe – ok')
  })

  it('can be read while still open', () => {
    const collector = collectingStream()
    collector.stream.write('partial')
    expect(collector.text()).toBe('partial')
  })
})
