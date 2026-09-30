// Shared bounded PCM preparation for file audio and WebCodecs video audio.
export const SAMPLE_RATE = 16000;
export const MAX_MEDIA_SECONDS = 600;
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

export function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Cancelled. Nothing was imported.', 'AbortError');
}

export function requireMediaConsent(options) {
  if (options?.consent !== true) throw new Error('Explicit on-device transcription consent is required.');
  checkAbort(options.signal);
}

// Average all channels, interpolate on a globally aligned 16kHz grid.
// Samples are bounded by MAX_MEDIA_SECONDS even when metadata is misleading.
export function writeMono16k(target, channels, rate, timestamp = 0) {
  const n = channels?.[0]?.length;
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000
    || !Number.isFinite(timestamp) || !n || channels.length > 8
    || channels.some(c => !(c instanceof Float32Array) || c.length !== n)) {
    throw new Error('Invalid or unsupported decoded audio.');
  }
  const end = Math.round((timestamp + n / rate) * SAMPLE_RATE);
  if (end > target.length) throw new Error('Recording exceeds the 10-minute audio limit.');
  const start = Math.max(0, Math.round(timestamp * SAMPLE_RATE));
  for (let i = start; i < end; i++) {
    const x = Math.max(0, Math.min(n - 1, (i / SAMPLE_RATE - timestamp) * rate));
    const left = Math.floor(x);
    const right = Math.min(n - 1, left + 1);
    let sum = 0;
    for (const channel of channels) {
      const value = channel[left] + (channel[right] - channel[left]) * (x - left);
      if (!Number.isFinite(value)) throw new Error('Non-finite decoded audio sample.');
      sum += value;
    }
    target[i] = sum / channels.length;
  }
  return Math.max(0, end);
}

export function audioBufferToMono16k(buffer) {
  if (!(buffer.duration > 0) || buffer.duration > MAX_MEDIA_SECONDS) {
    throw new Error('Use a recording with up to 10 minutes of audio.');
  }
  const result = new Float32Array(Math.round(buffer.duration * SAMPLE_RATE));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  writeMono16k(result, channels, buffer.sampleRate);
  return result;
}
