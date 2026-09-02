import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classifyMedia, MediaClass } from './classification.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CANONICAL_MANIFEST_NAME = 'batch_authorization_manifest.json';
export const DEFAULT_MANIFEST_PATH = path.resolve(__dirname, '../../batch_authorization_manifest.json');

/**
 * Computes an immutable pre-normalization candidate identity.
 * 
 * @param {string} fullPath 
 * @param {object} facts 
 * @param {string} matchedBucket 
 * @returns {{ path: string, bucketId: string, fingerprint: string }}
 */
export function computeCandidateIdentity(fullPath, facts, matchedBucket) {
  const normalizedPath = path.normalize(fullPath).replace(/\\/g, '/');
  const v = facts?.video || {};
  const fp = crypto.createHash('sha256').update([
    normalizedPath,
    matchedBucket,
    v.durationSec || 0,
    v.width || 0,
    v.height || 0,
    v.rFps || '',
    v.avgFps || '',
    v.codecTag || ''
  ].join('|')).digest('hex');

  return {
    path: normalizedPath,
    bucketId: matchedBucket,
    fingerprint: fp
  };
}

/**
 * Computes a deterministic universe digest from candidate identities.
 * 
 * @param {Array<{ path: string, bucketId: string, fingerprint: string }>} candidateIdentities 
 * @returns {string} Hex sha256 digest
 */
export function computeUniverseDigest(candidateIdentities) {
  const sorted = [...candidateIdentities].sort((a, b) => a.path.localeCompare(b.path));
  const canonicalJson = JSON.stringify(sorted.map(c => [c.path, c.bucketId, c.fingerprint]));
  return crypto.createHash('sha256').update(canonicalJson).digest('hex');
}

/**
 * Reconstructs the exact-certified universe from raw inventory items.
 * 
 * @param {Array<object>} inventoryItems 
 * @returns {{ count: number, bucketBreakdown: object, universeDigest: string, candidates: Array }}
 */
export function reconstructUniverseFromInventory(inventoryItems) {
  const candidates = [];
  const bucketBreakdown = {
    BUCKET_A1_4K_59FPS_SIVR033: 0,
    BUCKET_A2_4K_60FPS_WAKUI: 0,
    BUCKET_B_8K_60FPS_KAMIKI: 0
  };

  for (const item of inventoryItems) {
    const fullPath = item.fullPath || item.path;
    if (!fullPath) continue;

    const res = classifyMedia(fullPath, item.facts);
    if (res.classification === MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE) {
      const bucketId = res.matchedBucket;
      bucketBreakdown[bucketId] = (bucketBreakdown[bucketId] || 0) + 1;
      const identity = computeCandidateIdentity(fullPath, item.facts, bucketId);
      candidates.push(identity);
    }
  }

  candidates.sort((a, b) => a.path.localeCompare(b.path));
  const universeDigest = computeUniverseDigest(candidates);

  return {
    count: candidates.length,
    bucketBreakdown,
    universeDigest,
    candidates
  };
}

/**
 * Verifies local inventory against the tracked authorization manifest.
 * Fails closed if manifest is missing, corrupt, or universe identity has drifted.
 * 
 * @param {object} [options]
 * @returns {{ ok: boolean, count?: number, bucketBreakdown?: object, universeDigest?: string, reason?: string, error?: string }}
 */
export function verifyAuthorizationUniverse(options = {}) {
  const manifestPath = options.manifestPath || DEFAULT_MANIFEST_PATH;
  const inventoryPath = options.inventoryPath || path.resolve(__dirname, '../../scanned_raw_library.json');
  const fileOps = options.fileOps || {};
  const existsFn = fileOps.existsSync || fs.existsSync;
  const readFn = fileOps.readFileSync || fs.readFileSync;

  if (!existsFn(manifestPath)) {
    return { ok: false, reason: 'MANIFEST_NOT_FOUND', error: `Manifest file not found: ${manifestPath}` };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFn(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'MANIFEST_CORRUPT', error: `Failed to parse manifest JSON: ${err.message}` };
  }

  if (typeof manifest.acceptedUniverseCount !== 'number' || !manifest.universeDigest || !manifest.bucketBreakdown) {
    return { ok: false, reason: 'MANIFEST_MALFORMED', error: 'Manifest missing required fields' };
  }

  if (!existsFn(inventoryPath)) {
    return { ok: false, reason: 'INVENTORY_NOT_FOUND', error: `Inventory file not found: ${inventoryPath}` };
  }

  let rawInventory;
  try {
    rawInventory = JSON.parse(readFn(inventoryPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'INVENTORY_CORRUPT', error: `Failed to parse inventory JSON: ${err.message}` };
  }

  const reconstructed = reconstructUniverseFromInventory(rawInventory);

  // 1. Count verification
  if (reconstructed.count !== manifest.acceptedUniverseCount) {
    return {
      ok: false,
      reason: 'UNIVERSE_COUNT_MISMATCH',
      error: `Expected ${manifest.acceptedUniverseCount} items, but inventory produced ${reconstructed.count}`
    };
  }

  // 2. Bucket breakdown verification
  for (const [bucket, expectedCount] of Object.entries(manifest.bucketBreakdown)) {
    const actualCount = reconstructed.bucketBreakdown[bucket] || 0;
    if (actualCount !== expectedCount) {
      return {
        ok: false,
        reason: 'BUCKET_BREAKDOWN_MISMATCH',
        error: `Bucket ${bucket} expected ${expectedCount}, but got ${actualCount}`
      };
    }
  }

  // 3. Universe digest verification
  if (reconstructed.universeDigest !== manifest.universeDigest) {
    return {
      ok: false,
      reason: 'UNIVERSE_DIGEST_MISMATCH',
      error: `Reconstructed digest ${reconstructed.universeDigest} !== manifest digest ${manifest.universeDigest}`
    };
  }

  return {
    ok: true,
    count: reconstructed.count,
    bucketBreakdown: reconstructed.bucketBreakdown,
    universeDigest: reconstructed.universeDigest
  };
}
