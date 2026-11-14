import { unzipSync } from 'fflate';

/**
 * Garmin's download-service returns the original upload, zipped
 * (application/x-zip-compressed). Usually one .fit inside; manual uploads can
 * be .gpx/.tcx. Also accept a bare FIT in case the server ever skips the zip.
 */
export interface ActivityFileEntry {
  name: string;
  ext: string;
  bytes: Uint8Array;
}

export function isZip(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** FIT header: byte 0 = header size (12 or 14), bytes 8..11 = ".FIT". */
export function isFitBytes(b: Uint8Array): boolean {
  return b.length >= 12 && (b[0] === 12 || b[0] === 14) && b[8] === 0x2e && b[9] === 0x46 && b[10] === 0x49 && b[11] === 0x54;
}

export function extractActivityFiles(bytes: Uint8Array, fallbackName: string): ActivityFileEntry[] {
  if (isZip(bytes)) {
    const files = unzipSync(bytes);
    return Object.entries(files)
      .filter(([name]) => !name.endsWith('/'))
      .map(([name, data]) => ({ name: name.split('/').pop() ?? name, ext: extOf(name), bytes: data }));
  }
  if (isFitBytes(bytes)) return [{ name: `${fallbackName}.fit`, ext: 'fit', bytes }];
  return [{ name: `${fallbackName}.bin`, ext: 'bin', bytes }];
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m?.[1]?.toLowerCase() ?? '';
}
