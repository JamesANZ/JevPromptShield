import { ShieldError } from "../errors.js";
import type { MediaKind } from "./transcribe.js";

export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_SIDE = 16_384;
export const MAX_AUDIO_SECONDS = 300;
const MIN_AUDIO_BITS_PER_SECOND = 8_000;

function invalidMedia(kind: MediaKind, mediaType: string): ShieldError {
  return new ShieldError(
    "invalid_request",
    `${kind} bytes are not a valid or supported ${mediaType} file.`,
  );
}

function startsWith(bytes: Buffer, value: string | number[], offset = 0): boolean {
  const expected = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return bytes.subarray(offset, offset + expected.length).equals(expected);
}

function checkDimensions(
  width: number,
  height: number,
  kind: MediaKind,
  mediaType: string,
): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw invalidMedia(kind, mediaType);
  }
  if (
    width > MAX_IMAGE_SIDE ||
    height > MAX_IMAGE_SIDE ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new ShieldError(
      "oversize",
      `image dimensions exceed ${MAX_IMAGE_SIDE} pixels per side or ${MAX_IMAGE_PIXELS} total pixels.`,
    );
  }
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && length >= 7) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return undefined;
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const format = bytes.toString("ascii", 12, 16);
  if (format === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (format === "VP8 " && bytes.length >= 30 && startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (format === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21]!;
    const b2 = bytes[22]!;
    const b3 = bytes[23]!;
    const b4 = bytes[24]!;
    return {
      width: 1 + b1 + ((b2 & 0x3f) << 8),
      height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
    };
  }
  return undefined;
}

function validateImage(mediaType: string, bytes: Buffer): void {
  let dimensions: { width: number; height: number } | undefined;
  if (mediaType === "image/png") {
    if (bytes.length < 24 || !startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || bytes.toString("ascii", 12, 16) !== "IHDR") {
      throw invalidMedia("image", mediaType);
    }
    dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (mediaType === "image/jpeg") {
    if (!startsWith(bytes, [0xff, 0xd8, 0xff])) throw invalidMedia("image", mediaType);
    dimensions = jpegDimensions(bytes);
  } else if (mediaType === "image/gif") {
    if (bytes.length < 10 || (!startsWith(bytes, "GIF87a") && !startsWith(bytes, "GIF89a"))) {
      throw invalidMedia("image", mediaType);
    }
    dimensions = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  } else if (mediaType === "image/webp") {
    if (bytes.length < 25 || !startsWith(bytes, "RIFF") || !startsWith(bytes, "WEBP", 8)) {
      throw invalidMedia("image", mediaType);
    }
    dimensions = webpDimensions(bytes);
  }
  if (!dimensions) throw invalidMedia("image", mediaType);
  checkDimensions(dimensions.width, dimensions.height, "image", mediaType);
}

function checkDuration(seconds: number | undefined, bytes: Buffer, mediaType: string): void {
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0)) {
    throw invalidMedia("audio", mediaType);
  }
  const conservativelyTooLong =
    seconds === undefined &&
    bytes.length > (MAX_AUDIO_SECONDS * MIN_AUDIO_BITS_PER_SECOND) / 8;
  if ((seconds !== undefined && seconds > MAX_AUDIO_SECONDS) || conservativelyTooLong) {
    throw new ShieldError(
      "oversize",
      `audio exceeds ${MAX_AUDIO_SECONDS} seconds or its duration cannot be verified within that limit.`,
    );
  }
}

function wavDuration(bytes: Buffer): number {
  let offset = 12;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= bytes.length) {
    const chunk = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > bytes.length) throw invalidMedia("audio", "audio/wav");
    if (chunk === "fmt " && length >= 16) byteRate = bytes.readUInt32LE(start + 8);
    if (chunk === "data") dataBytes = length;
    offset = start + length + (length % 2);
  }
  if (!byteRate || dataBytes === undefined) throw invalidMedia("audio", "audio/wav");
  return dataBytes / byteRate;
}

function flacDuration(bytes: Buffer): number {
  if (bytes.length < 26 || bytes[4] !== 0 || bytes.readUIntBE(5, 3) < 34) {
    throw invalidMedia("audio", "audio/flac");
  }
  const b20 = bytes[20]!;
  const sampleRate = (bytes[18]! << 12) | (bytes[19]! << 4) | (b20 >> 4);
  const totalSamples = (b20 & 0x0f) * 2 ** 32 + bytes.readUInt32BE(21);
  if (sampleRate === 0 || totalSamples === 0) throw invalidMedia("audio", "audio/flac");
  return totalSamples / sampleRate;
}

function mp3Duration(bytes: Buffer): number | undefined {
  let offset = 0;
  if (startsWith(bytes, "ID3")) {
    if (bytes.length < 10) throw invalidMedia("audio", "audio/mpeg");
    const size = bytes.readUInt32BE(6);
    const synchsafe = ((size & 0x7f000000) >>> 3) | ((size & 0x7f0000) >>> 2) | ((size & 0x7f00) >>> 1) | (size & 0x7f);
    offset = 10 + synchsafe;
  }
  let duration = 0;
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.readUInt32BE(offset);
    if ((header & 0xffe00000) !== 0xffe00000) break;
    const version = (header >>> 19) & 3;
    const layer = (header >>> 17) & 3;
    const bitrateIndex = (header >>> 12) & 15;
    const rateIndex = (header >>> 10) & 3;
    if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) break;
    const v1 = version === 3;
    const rates = v1 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
    const sampleRate = rates[rateIndex]!;
    const tables = v1
      ? layer === 3 ? [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
        : layer === 2 ? [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
          : [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : layer === 3 ? [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
        : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const bitrate = tables[bitrateIndex - 1]! * 1000;
    const samples = layer === 3 ? 384 : layer === 2 ? 1152 : v1 ? 1152 : 576;
    const padding = (header >>> 9) & 1;
    const length = layer === 3
      ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
      : Math.floor((samples / 8) * bitrate / sampleRate) + padding;
    if (length < 4 || offset + length > bytes.length) break;
    duration += samples / sampleRate;
    frames += 1;
    offset += length;
  }
  if (frames === 0) throw invalidMedia("audio", "audio/mpeg");
  return duration;
}

function mp4Duration(bytes: Buffer): number | undefined {
  const box = bytes.indexOf("mvhd");
  if (box < 0 || box + 28 > bytes.length) return undefined;
  const version = bytes[box + 4];
  if (version === 1 && box + 40 <= bytes.length) {
    const timescale = bytes.readUInt32BE(box + 28);
    const duration = Number(bytes.readBigUInt64BE(box + 32));
    return timescale ? duration / timescale : undefined;
  }
  const timescale = bytes.readUInt32BE(box + 20);
  const duration = bytes.readUInt32BE(box + 24);
  return timescale ? duration / timescale : undefined;
}

function oggDuration(bytes: Buffer): number | undefined {
  const head = bytes.indexOf("OpusHead");
  const vorbis = bytes.indexOf(Buffer.from([1, ...Buffer.from("vorbis")]));
  const sampleRate = head >= 0 ? 48_000 : vorbis >= 0 && vorbis + 16 <= bytes.length ? bytes.readUInt32LE(vorbis + 12) : undefined;
  const lastPage = bytes.lastIndexOf("OggS");
  if (!sampleRate || lastPage < 0 || lastPage + 14 > bytes.length) return undefined;
  const granule = Number(bytes.readBigInt64LE(lastPage + 6));
  return granule < 0 ? undefined : granule / sampleRate;
}

function validateAudio(mediaType: string, bytes: Buffer): void {
  let duration: number | undefined;
  if (mediaType === "audio/wav") {
    if (!startsWith(bytes, "RIFF") || !startsWith(bytes, "WAVE", 8)) throw invalidMedia("audio", mediaType);
    duration = wavDuration(bytes);
  } else if (mediaType === "audio/mpeg") {
    if (!startsWith(bytes, "ID3") && !startsWith(bytes, [0xff])) throw invalidMedia("audio", mediaType);
    duration = mp3Duration(bytes);
  } else if (mediaType === "audio/webm") {
    if (!startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) throw invalidMedia("audio", mediaType);
  } else if (mediaType === "audio/mp4") {
    if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") throw invalidMedia("audio", mediaType);
    duration = mp4Duration(bytes);
  } else if (mediaType === "audio/ogg") {
    if (!startsWith(bytes, "OggS")) throw invalidMedia("audio", mediaType);
    duration = oggDuration(bytes);
  } else if (mediaType === "audio/flac") {
    if (!startsWith(bytes, "fLaC")) throw invalidMedia("audio", mediaType);
    duration = flacDuration(bytes);
  }
  checkDuration(duration, bytes, mediaType);
}

export function validateMedia(kind: MediaKind, mediaType: string, bytes: Buffer): void {
  if (kind === "image") validateImage(mediaType, bytes);
  else validateAudio(mediaType, bytes);
}
