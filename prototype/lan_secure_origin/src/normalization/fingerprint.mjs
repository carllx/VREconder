import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Generates a stable fingerprint for a media file based on canonical path,
 * size in bytes, and last modification timestamp (mtimeMs).
 * 
 * @param {string} filePath - Absolute path to the media file
 * @returns {{ canonicalPath: string, sizeBytes: number, mtimeMs: number, fingerprintId: string } | null}
 */
export function getMediaFingerprint(filePath) {
  try {
    const canonicalPath = path.normalize(path.resolve(filePath));
    if (!fs.existsSync(canonicalPath)) return null;

    const stat = fs.statSync(canonicalPath);
    if (!stat.isFile()) return null;

    const hash = crypto.createHash('sha256');
    hash.update(`${canonicalPath}|${stat.size}|${Math.floor(stat.mtimeMs)}`);
    const fingerprintId = hash.digest('hex').substring(0, 16);

    return {
      canonicalPath,
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      fingerprintId
    };
  } catch (err) {
    return null;
  }
}

/**
 * Checks if a cached fact entry matches current file state.
 * 
 * @param {string} filePath 
 * @param {{ sizeBytes: number, mtimeMs: number }} cachedEntry 
 * @returns {boolean}
 */
export function isFingerprintValid(filePath, cachedEntry) {
  if (!cachedEntry) return false;
  const current = getMediaFingerprint(filePath);
  if (!current) return false;
  return current.sizeBytes === cachedEntry.sizeBytes && current.mtimeMs === cachedEntry.mtimeMs;
}
