// Real container demuxing + native WebCodecs audio decoding, no video frames.
// Vendored Mediabunny is loaded from this origin, not from a CDN. BlobSource
// reads local ranges; the video file is never converted to one giant buffer.
import { validateVideoFile } from './video-ingestion-bridge.js';
import {
  SAMPLE_RATE, MAX_MEDIA_SECONDS, MAX_MEDIA_BYTES, writeMono16k, checkAbort, requireMediaConsent,
} from '../audio/audio-pcm.js';

export function isVideoExtractionAvailable() {
  return typeof globalThis.AudioDecoder === 'function' && typeof globalThis.AudioData === 'function';
}

export async function extractVideoAudio(file, options = {}) {
  requireMediaConsent(options);
  const validation = validateVideoFile(file?.name, file?.type, file?.size / (1024 * 1024));
  if (!validation.valid) throw new Error(validation.error);
  if (!(file.size > 0) || file.size > MAX_MEDIA_BYTES) {
    throw new Error('Choose a non-empty video up to 200 MiB.');
  }
  if (!isVideoExtractionAvailable()) throw new Error('WebCodecs audio decoding is unavailable here.');
  const { Input, BlobSource, MP4, QTFF, WEBM, AudioSampleSink } =
    await import('../../assets/vendor/mediabunny/mediabunny.min.mjs');
  checkAbort(options.signal);
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, WEBM] });
  const abort = () => input.dispose();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const tracks = await input.getAudioTracks();
    const track = await input.getPrimaryAudioTrack();
    checkAbort(options.signal);
    if (!track) throw new Error('This video has no audio track. Nothing was imported.');
    const config = await track.getDecoderConfig();
    if (!config || !(await AudioDecoder.isConfigSupported(config)).supported) {
      throw new Error('This browser cannot decode this audio codec. Try MP4/AAC or WebM/Opus.');
    }
    const duration = await track.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_MEDIA_SECONDS) {
      throw new Error('Use a video with up to 10 minutes of audio.');
    }
    const audio = new Float32Array(MAX_MEDIA_SECONDS * SAMPLE_RATE);
    let end = 0;
    let chunks = 0;
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        checkAbort(options.signal);
        if (sample.numberOfChannels > 8 || sample.numberOfFrames > 192000 * 30) {
          throw new Error('Unsupported audio chunk dimensions.');
        }
        const channels = Array.from({ length: sample.numberOfChannels }, (_, planeIndex) => {
          const channel = new Float32Array(sample.numberOfFrames);
          sample.copyTo(channel, { planeIndex, format: 'f32-planar' });
          return channel;
        });
        end = Math.max(end, writeMono16k(audio, channels, sample.sampleRate, sample.timestamp));
        chunks++;
        if (chunks % 20 === 0) {
          options.onProgress?.({ text: 'Extracting the primary audio track', progress: Math.min(1, end / SAMPLE_RATE / duration) });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } finally { sample.close(); }
    }
    checkAbort(options.signal);
    if (!end) throw new Error('No decodable audio samples found. Nothing was imported.');
    return {
      audio: audio.slice(0, end),
      metadata: {
        sourceFile: file.name, source: 'video-transcript', codec: config.codec,
        audioTrackCount: tracks.length, selectedTrack: 'primary',
        durationSec: end / SAMPLE_RATE, sampleRate: SAMPLE_RATE,
        extractionMode: 'audio_only', framesAnalyzed: false,
      },
    };
  } catch (error) {
    checkAbort(options.signal);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    input.dispose();
  }
}
