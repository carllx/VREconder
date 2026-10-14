import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BATCH_PROBE_POLICY_VERSION, BatchProbeVerdict } from './batch-probe-types.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DIR = path.resolve(__dirname, '..', '..');

export function getBatchProbeFilePaths(baseDir = DEFAULT_DIR) {
  return {
    registry: path.join(baseDir, 'batch_probe_registry.jsonl'),
    checkpoint: path.join(baseDir, 'batch_probe_checkpoint.json')
  };
}

/**
 * Generates a cryptographically strong session probe token.
 *
 * @returns {string}
 */
export function generateSessionToken() {
  return crypto.randomBytes(16).toString('hex');
}

let activePairingPin = null;
let pairingPinExpiresAt = 0;
const failedAttemptsMap = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;

/**
 * Generates a cryptographically secure 6-digit pairing PIN with 15-minute TTL.
 *
 * @returns {{ pin: string, expiresAt: number }}
 */
export function generatePairingPin() {
  activePairingPin = String(crypto.randomInt(100000, 1000000));
  pairingPinExpiresAt = Date.now() + 15 * 60 * 1000;
  return { pin: activePairingPin, expiresAt: pairingPinExpiresAt };
}

export function getActivePairingPin() {
  if (activePairingPin && Date.now() < pairingPinExpiresAt) {
    return { pin: activePairingPin, expiresAt: pairingPinExpiresAt };
  }
  return generatePairingPin();
}

export function checkPairingRateLimit(clientIp = 'default') {
  const now = Date.now();
  const entry = failedAttemptsMap.get(clientIp);
  if (!entry) return { allowed: true };
  if (entry.lockedUntil > now) {
    const retryAfterSec = Math.ceil((entry.lockedUntil - now) / 1000);
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true };
}

export function recordPairingFailure(clientIp = 'default') {
  const now = Date.now();
  const entry = failedAttemptsMap.get(clientIp) || { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.count = 0;
  }
  failedAttemptsMap.set(clientIp, entry);
  return entry;
}

export function recordPairingSuccess(clientIp = 'default') {
  failedAttemptsMap.delete(clientIp);
}

/**
 * Verifies pairing PIN with rate limiting and single-use redemption semantics.
 *
 * @param {string} inputPin
 * @param {string} [clientIp]
 * @returns {{ valid: boolean, reason?: string, retryAfterSec?: number }}
 */
export function verifyPairingPin(inputPin, clientIp = 'default') {
  if (!inputPin || typeof inputPin !== 'string') {
    return { valid: false, reason: 'INVALID_INPUT' };
  }
  const rateLimit = checkPairingRateLimit(clientIp);
  if (!rateLimit.allowed) {
    return { valid: false, reason: 'RATE_LIMITED', retryAfterSec: rateLimit.retryAfterSec };
  }

  if (!activePairingPin || Date.now() >= pairingPinExpiresAt) {
    const failureEntry = recordPairingFailure(clientIp);
    if (failureEntry.lockedUntil > Date.now()) {
      const retryAfterSec = Math.ceil((failureEntry.lockedUntil - Date.now()) / 1000);
      return { valid: false, reason: 'RATE_LIMITED', retryAfterSec };
    }
    return { valid: false, reason: 'PIN_EXPIRED_OR_ABSENT' };
  }

  if (inputPin.trim() === activePairingPin) {
    activePairingPin = null; // single-use: invalidated immediately upon redemption
    pairingPinExpiresAt = 0;
    recordPairingSuccess(clientIp);
    return { valid: true };
  } else {
    const failureEntry = recordPairingFailure(clientIp);
    if (failureEntry.lockedUntil > Date.now()) {
      const retryAfterSec = Math.ceil((failureEntry.lockedUntil - Date.now()) / 1000);
      return { valid: false, reason: 'RATE_LIMITED', retryAfterSec };
    }
    return { valid: false, reason: 'PIN_MISMATCH' };
  }
}

/**
 * Loads all array records from batch_probe_registry.jsonl.
 *
 * @param {string} [baseDir]
 * @returns {Array<object>}
 */
export function loadBatchRegistryRecords(baseDir = DEFAULT_DIR) {
  const { registry } = getBatchProbeFilePaths(baseDir);
  const records = [];
  if (!fs.existsSync(registry)) return records;

  try {
    const lines = fs.readFileSync(registry, 'utf8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item) records.push(item);
      } catch (_) {}
    }
  } catch (err) {
    console.warn('[BatchProbeStore] Failed reading registry:', err.message);
  }
  return records;
}

/**
 * Loads all records from batch_probe_registry.jsonl mapped by fingerprintId.
 *
 * @param {string} [baseDir]
 * @returns {Map<string, object>}
 */
export function loadBatchRegistry(baseDir = DEFAULT_DIR) {
  const records = loadBatchRegistryRecords(baseDir);
  const map = new Map();
  for (const item of records) {
    if (item && item.fingerprintId) {
      map.set(item.fingerprintId, item);
    }
  }
  return map;
}

/**
 * Loads records filtered by specific runId for run-scoped accounting.
 *
 * @param {string} runId
 * @param {string} [baseDir]
 * @returns {Array<object>}
 */
export function loadBatchRegistryForRun(runId, baseDir = DEFAULT_DIR) {
  const records = loadBatchRegistryRecords(baseDir);
  if (!runId) return records;
  return records.filter(r => r.runId === runId);
}

/**
 * Appends a probe result to batch_probe_registry.jsonl.
 *
 * @param {object} record
 * @param {string} [baseDir]
 * @returns {object}
 */
export function recordBatchResult(record, baseDir = DEFAULT_DIR) {
  const { registry } = getBatchProbeFilePaths(baseDir);
  const entry = {
    ...record,
    policyVersion: record.policyVersion || BATCH_PROBE_POLICY_VERSION,
    timestamp: record.timestamp || new Date().toISOString()
  };

  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(registry, line, 'utf8');
  return entry;
}

/**
 * Validates whether an existing checkpoint matches the current active root and candidate inventory.
 *
 * @param {object} cp
 * @param {string} currentRoot
 * @param {string} currentCandidatesHash
 * @returns {{ valid: boolean, reason: string | null }}
 */
export function validateCheckpointIntegrity(cp, currentRoot, currentCandidatesHash) {
  if (!cp || !cp.runId) {
    return { valid: false, reason: 'No active run checkpoint' };
  }
  if (cp.rootPath && currentRoot) {
    const normCp = path.normalize(cp.rootPath).toLowerCase();
    const normCur = path.normalize(currentRoot).toLowerCase();
    if (normCp !== normCur) {
      return { valid: false, reason: `Active media root changed: checkpoint was for ${cp.rootPath}, current is ${currentRoot}` };
    }
  }
  if (cp.candidatesHash && currentCandidatesHash && cp.candidatesHash !== currentCandidatesHash) {
    return { valid: false, reason: 'Candidate inventory snapshot mismatch: media set in folder changed' };
  }
  return { valid: true, reason: null };
}

/**
 * Loads batch probe checkpoint.
 *
 * @param {string} [baseDir]
 * @returns {object}
 */
export function loadBatchCheckpoint(baseDir = DEFAULT_DIR) {
  const { checkpoint } = getBatchProbeFilePaths(baseDir);
  if (!fs.existsSync(checkpoint)) {
    return {
      runId: null,
      rootPath: null,
      candidatesHash: null,
      sessionToken: null,
      status: 'IDLE',
      cursor: 0,
      totalQueue: 0,
      completedCount: 0,
      passCount: 0,
      failCount: 0,
      inconclusiveCount: 0,
      lastUpdated: null,
      lastTestedItem: null
    };
  }

  try {
    return JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
  } catch (_) {
    return {
      runId: null,
      rootPath: null,
      candidatesHash: null,
      sessionToken: null,
      status: 'IDLE',
      cursor: 0,
      totalQueue: 0,
      completedCount: 0,
      passCount: 0,
      failCount: 0,
      inconclusiveCount: 0,
      lastUpdated: null,
      lastTestedItem: null
    };
  }
}

/**
 * Saves batch checkpoint atomically.
 *
 * @param {object} cp
 * @param {string} [baseDir]
 * @returns {object}
 */
export function saveBatchCheckpoint(cp, baseDir = DEFAULT_DIR) {
  const { checkpoint } = getBatchProbeFilePaths(baseDir);
  const updated = {
    ...cp,
    lastUpdated: new Date().toISOString()
  };
  const tmp = `${checkpoint}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf8');
  fs.renameSync(tmp, checkpoint);
  return updated;
}
