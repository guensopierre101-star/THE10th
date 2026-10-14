/**
 * Low-latency raw PCM audio utilities for Gemini Live API
 * Input: 16kHz, 16-bit, mono, little-endian PCM ("audio/pcm;rate=16000")
 * Output: 24kHz, 16-bit, mono, little-endian PCM
 */

export function encodeFloat32ToBase64Pcm16(
  inputSamples: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000
): string {
  let samples = inputSamples;

  if (inputSampleRate !== targetSampleRate && inputSampleRate > 0) {
    const ratio = inputSampleRate / targetSampleRate;
    const newLength = Math.round(inputSamples.length / ratio);
    const resampled = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const idx = i * ratio;
      const indexFloor = Math.floor(idx);
      const indexCeil = Math.min(indexFloor + 1, inputSamples.length - 1);
      const frac = idx - indexFloor;
      resampled[i] =
        inputSamples[indexFloor] * (1 - frac) + inputSamples[indexCeil] * frac;
    }
    samples = resampled;
  }

  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const bytes = new Uint8Array(int16.buffer);
  const CHUNK_SIZE = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }

  return window.btoa(binary);
}

export function decodeBase64Pcm16ToFloat32(base64: string): Float32Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer, 0, Math.floor(len / 2));
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }
  return float32;
}

export function calculateRmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  const step = Math.max(1, Math.floor(samples.length / 256));
  let count = 0;
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i];
    sumSquares += s * s;
    count++;
  }
  const rms = Math.sqrt(sumSquares / count);
  return Math.min(1, rms * 4.2);
}
