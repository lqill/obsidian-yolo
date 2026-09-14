// src/core/realtime/audio/pcm.test.ts
import {
  base64ToBytes,
  base64ToInt16,
  bytesToBase64,
  float32ToInt16,
  int16ToBase64,
  int16ToFloat32,
  resampleLinear,
} from './pcm'

describe('pcm', () => {
  it('round-trips int16 <-> float32', () => {
    const i = new Int16Array([0, 32767, -32768, 16384])
    const f = int16ToFloat32(i)
    expect(f[1]).toBeCloseTo(1, 4)
    expect(f[2]).toBeCloseTo(-1, 4)
    expect(float32ToInt16(f)).toEqual(i)
  })

  it('clamps float32ToInt16 out-of-range values', () => {
    expect(Array.from(float32ToInt16(new Float32Array([2, -2])))).toEqual([
      32767, -32768,
    ])
  })

  it('round-trips base64 bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(
      Array.from(bytes),
    )
  })

  it('round-trips int16 base64', () => {
    const i = new Int16Array([1, -1, 300, -300])
    expect(int16ToBase64(new Int16Array([1]))).toBe('AQA=')
    expect(Array.from(base64ToInt16(int16ToBase64(i)))).toEqual(Array.from(i))
  })

  it('downsamples 48k -> 16k by 3x length', () => {
    const input = new Float32Array(48)
    for (let k = 0; k < input.length; k += 1)
      input[k] = Math.sin((k / 48) * Math.PI * 2)
    const out = resampleLinear(input, 48000, 16000)
    expect(out.length).toBe(16)
  })

  it('returns the input unchanged when rates match', () => {
    const input = new Float32Array([0.1, 0.2])
    expect(resampleLinear(input, 16000, 16000)).toBe(input)
  })

  it('returns an empty array for empty input', () => {
    expect(resampleLinear(new Float32Array(0), 48000, 16000).length).toBe(0)
  })
})
