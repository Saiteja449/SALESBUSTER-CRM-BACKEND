/**
 * Audio Processing Utilities for 16kHz 16-bit Mono PCM and RIFF WAV Encoding
 */

/**
 * Creates a standard 44-byte RIFF WAV header for raw PCM16 audio.
 * @param {Object} options
 * @param {number} options.dataLength - Length of raw PCM data in bytes
 * @param {number} [options.sampleRate=16000] - Sample rate in Hz
 * @param {number} [options.numChannels=1] - Number of audio channels (1 = Mono)
 * @param {number} [options.bitsPerSample=16] - Bits per audio sample
 * @returns {Buffer} 44-byte WAV header Buffer
 */
export function createWavHeader({
  dataLength,
  sampleRate = 16000,
  numChannels = 1,
  bitsPerSample = 16,
}) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  // Chunk ID: "RIFF"
  header.write("RIFF", 0);
  // Chunk Size: 36 + SubChunk2Size
  header.writeUInt32LE(36 + dataLength, 4);
  // Format: "WAVE"
  header.write("WAVE", 8);

  // Subchunk 1 ID: "fmt "
  header.write("fmt ", 12);
  // Subchunk 1 Size: 16 for PCM
  header.writeUInt32LE(16, 16);
  // Audio Format: 1 for uncompressed PCM
  header.writeUInt16LE(1, 20);
  // Number of channels
  header.writeUInt16LE(numChannels, 22);
  // Sample Rate
  header.writeUInt32LE(sampleRate, 24);
  // Byte Rate
  header.writeUInt32LE(byteRate, 28);
  // Block Align
  header.writeUInt16LE(blockAlign, 32);
  // Bits Per Sample
  header.writeUInt16LE(bitsPerSample, 34);

  // Subchunk 2 ID: "data"
  header.write("data", 36);
  // Subchunk 2 Size: dataLength
  header.writeUInt32LE(dataLength, 40);

  return header;
}

/**
 * Prepends a RIFF WAV header to a raw PCM16 buffer.
 * @param {Buffer} pcmBuffer - Raw PCM buffer
 * @param {number} [sampleRate=16000]
 * @param {number} [numChannels=1]
 * @param {number} [bitsPerSample=16]
 * @returns {Buffer} Complete WAV file buffer
 */
export function pcmToWav(
  pcmBuffer,
  sampleRate = 16000,
  numChannels = 1,
  bitsPerSample = 16
) {
  if (!Buffer.isBuffer(pcmBuffer)) {
    throw new TypeError("Input must be a valid Buffer");
  }
  const header = createWavHeader({
    dataLength: pcmBuffer.length,
    sampleRate,
    numChannels,
    bitsPerSample,
  });
  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Calculates audio duration in seconds from raw PCM byte length.
 * @param {number} byteLength - Byte length of PCM data
 * @param {number} [sampleRate=16000]
 * @param {number} [numChannels=1]
 * @param {number} [bitsPerSample=16]
 * @returns {number} Duration in seconds
 */
export function calculatePcmDuration(
  byteLength,
  sampleRate = 16000,
  numChannels = 1,
  bitsPerSample = 16
) {
  const bytesPerSecond = (sampleRate * numChannels * bitsPerSample) / 8;
  if (bytesPerSecond === 0) return 0;
  return Number((byteLength / bytesPerSecond).toFixed(3));
}

/**
 * Validates a base64 or Buffer PCM audio chunk.
 * @param {string|Buffer} chunk - Base64 string or Buffer
 * @returns {{ valid: boolean, buffer: Buffer, error?: string }}
 */
export function validatePcmChunk(chunk) {
  if (!chunk) {
    return { valid: false, buffer: null, error: "Empty audio chunk" };
  }

  let buf;
  if (Buffer.isBuffer(chunk)) {
    buf = chunk;
  } else if (typeof chunk === "string") {
    try {
      buf = Buffer.from(chunk, "base64");
    } catch {
      return { valid: false, buffer: null, error: "Invalid base64 encoding" };
    }
  } else {
    return { valid: false, buffer: null, error: "Unsupported chunk data type" };
  }

  // Check 16-bit alignment (must be multiple of 2 bytes)
  if (buf.length % 2 !== 0) {
    return {
      valid: false,
      buffer: null,
      error: "PCM chunk length is not 16-bit sample aligned",
    };
  }

  return { valid: true, buffer: buf };
}

/**
 * Segments a raw PCM buffer into smaller windows if recording exceeds max duration.
 * @param {Buffer} pcmBuffer - Complete PCM buffer
 * @param {number} [segmentDurationSec=1500] - 25 minutes default (below 30m diarization ceiling)
 * @param {number} [sampleRate=16000]
 * @returns {Array<{ segmentIndex: number, pcmBuffer: Buffer, startTimeSec: number, durationSec: number }>}
 */
export function segmentPcmBuffer(
  pcmBuffer,
  segmentDurationSec = 1500,
  sampleRate = 16000
) {
  const bytesPerSec = sampleRate * 2; // 16-bit mono = 2 bytes per sample
  const segmentSizeBytes = segmentDurationSec * bytesPerSec;

  if (pcmBuffer.length <= segmentSizeBytes) {
    return [
      {
        segmentIndex: 0,
        pcmBuffer,
        startTimeSec: 0,
        durationSec: calculatePcmDuration(pcmBuffer.length, sampleRate),
      },
    ];
  }

  const segments = [];
  let offset = 0;
  let index = 0;

  while (offset < pcmBuffer.length) {
    const end = Math.min(offset + segmentSizeBytes, pcmBuffer.length);
    const slice = pcmBuffer.subarray(offset, end);
    const startTimeSec = offset / bytesPerSec;
    const durationSec = calculatePcmDuration(slice.length, sampleRate);

    segments.push({
      segmentIndex: index,
      pcmBuffer: slice,
      startTimeSec,
      durationSec,
    });

    offset = end;
    index++;
  }

  return segments;
}

