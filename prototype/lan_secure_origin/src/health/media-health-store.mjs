import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEALTH_CHECK_POLICY_VERSION,
  COMPATIBILITY_POLICY_VERSION,
  FinalHealthState,
  StaticDisposition,
  ProbeVerdict
} from './media-health-types.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DIR = path.resolve(__dirname, '..', '..');

export function getHealthFilePaths(baseDir = DEFAULT_DIR) {
  return {
    registry: path.join(baseDir, 'media_health_registry.jsonl'),
    checkpoint: path.join(baseDir, 'media_health_checkpoint.json')
  };
}

/**
 * Loads all records from media_health_registry.jsonl.
 * Returns map keyed by fingerprintId.
 * 
 * @param {string} [baseDir] 
 * @returns {Map<string, object>}
 */
export function loadHealthRegistry(baseDir = DEFAULT_DIR) {
  const { registry } = getHealthFilePaths(baseDir);
  const records = new Map();
  if (!fs.existsSync(registry)) return records;

  try {
    const lines = fs.readFileSync(registry, 'utf8').split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item && item.fingerprintId) {
          records.set(item.fingerprintId, item);
        }
      } catch (_) {}
    }
  } catch (err) {
    console.warn('[MediaHealthStore] Failed reading registry:', err.message);
  }
  return records;
}

/**
 * Appends a health record to media_health_registry.jsonl.
 * 
 * @param {object} record 
 * @param {string} [baseDir] 
 * @returns {object}
 */
export function recordHealthResult(record, baseDir = DEFAULT_DIR) {
  const { registry } = getHealthFilePaths(baseDir);
  const entry = {
    ...record,
    timestamp: record.timestamp || new Date().toISOString(),
    healthCheckPolicyVersion: record.healthCheckPolicyVersion || HEALTH_CHECK_POLICY_VERSION,
    compatibilityPolicyVersion: record.compatibilityPolicyVersion || COMPATIBILITY_POLICY_VERSION
  };

  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(registry, line, 'utf8');
  return entry;
}

/**
 * Loads checkpoint file.
 * 
 * @param {string} [baseDir] 
 * @returns {object}
 */
export function loadCheckpoint(baseDir = DEFAULT_DIR) {
  const { checkpoint } = getHealthFilePaths(baseDir);
  if (!fs.existsSync(checkpoint)) {
    return {
      runId: null,
      status: 'IDLE', // IDLE, RUNNING, PAUSED, COMPLETED
      cursor: 0,
      totalQueue: 0,
      completedCount: 0,
      passCount: 0,
      failCount: 0,
      lastUpdated: null,
      lastTestedItem: null
    };
  }

  try {
    return JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
  } catch (e) {
    return {
      runId: null,
      status: 'IDLE',
      cursor: 0,
      totalQueue: 0,
      completedCount: 0,
      passCount: 0,
      failCount: 0,
      lastUpdated: null,
      lastTestedItem: null
    };
  }
}

/**
 * Saves checkpoint atomically.
 * 
 * @param {object} cp 
 * @param {string} [baseDir] 
 */
export function saveCheckpoint(cp, baseDir = DEFAULT_DIR) {
  const { checkpoint } = getHealthFilePaths(baseDir);
  const updated = {
    ...cp,
    lastUpdated: new Date().toISOString()
  };
  const tmp = `${checkpoint}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf8');
  fs.renameSync(tmp, checkpoint);
  return updated;
}
