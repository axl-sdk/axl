/**
 * Playground image attachments are deliberately single-run, HTTP-only data.
 * Five MiB leaves headroom for a JSON/base64 request while keeping local
 * development requests modest; the server validates decoded bytes too.
 */
export const PLAYGROUND_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Maximum standard-base64 payload for the decoded cap, plus a small JSON envelope. */
export const PLAYGROUND_IMAGE_MAX_BASE64_CHARACTERS = Math.ceil(PLAYGROUND_IMAGE_MAX_BYTES / 3) * 4;
export const PLAYGROUND_IMAGE_REQUEST_MAX_BYTES =
  PLAYGROUND_IMAGE_MAX_BASE64_CHARACTERS + 16 * 1024;

export const PLAYGROUND_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type PlaygroundImageMediaType = (typeof PLAYGROUND_IMAGE_MEDIA_TYPES)[number];

export type PlaygroundImageAttachment = {
  mediaType: PlaygroundImageMediaType;
  data: string;
  label?: string;
};

export function isPlaygroundImageMediaType(value: unknown): value is PlaygroundImageMediaType {
  return (
    typeof value === 'string' && (PLAYGROUND_IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
  );
}

/** Strict standard base64 only. Data URLs are intentionally not accepted. */
export function base64ByteLength(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return undefined;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodedPrefix(value: string, length: number): Uint8Array | undefined {
  try {
    const prefix = value.slice(0, Math.ceil(length / 3) * 4);
    const decoded = atob(prefix);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** Check only a small decoded prefix; the full payload remains opaque bytes. */
export function hasMatchingImageSignature(
  mediaType: PlaygroundImageMediaType,
  data: string,
): boolean {
  const bytes = decodedPrefix(data, 12);
  if (!bytes) return false;
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  switch (mediaType) {
    case 'image/png':
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/jpeg':
      return startsWith(0xff, 0xd8, 0xff);
    case 'image/gif':
      return (
        startsWith(0x47, 0x49, 0x46, 0x38) &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
      );
    case 'image/webp':
      return startsWith(0x52, 0x49, 0x46, 0x46) && startsWithAt(bytes, 8, 0x57, 0x45, 0x42, 0x50);
  }
}

function startsWithAt(bytes: Uint8Array, offset: number, ...prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}
