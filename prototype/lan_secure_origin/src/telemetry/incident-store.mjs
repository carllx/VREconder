import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Default storage directory is prototype/lan_secure_origin
const DEFAULT_DIR = path.resolve(__dirname, '..', '..');

export function getIncidentFilePaths(baseDir = DEFAULT_DIR) {
  return {
    pending: path.join(baseDir, 'runtime_incidents.pending.jsonl'),
    processed: path.join(baseDir, 'runtime_incidents.processed.jsonl')
  };
}

/**
 * Record a runtime incident to the pending JSONL store.
 * 
 * @param {Object} incident
 * @param {string} [baseDir]
 * @returns {Object} recorded incident with assigned incidentId and timestamp
 */
export function recordIncident(incident, baseDir = DEFAULT_DIR) {
  const { pending } = getIncidentFilePaths(baseDir);
  const now = new Date().toISOString();
  const rand = crypto.randomBytes(4).toString('hex');
  const incidentId = incident.incidentId || `inc_${Date.now()}_${rand}`;

  const entry = {
    incidentId,
    timestamp: incident.timestamp || now,
    eventType: incident.eventType || 'UNKNOWN_EVENT',
    severity: incident.severity || 'WARN',
    fingerprintId: incident.fingerprintId || null,
    localMediaName: incident.localMediaName || '',
    localMediaPath: incident.localMediaPath || '',
    classification: incident.classification || 'UNCLASSIFIED',
    reason: incident.reason || '',
    matchedEnvelopeId: incident.matchedEnvelopeId || null,
    allowedNextActions: Array.isArray(incident.allowedNextActions) ? incident.allowedNextActions : [],
    occurrenceSource: incident.occurrenceSource || 'client',
    metadata: incident.metadata || {}
  };

  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(pending, line, 'utf8');
  return entry;
}

/**
 * Read all pending incidents from runtime_incidents.pending.jsonl.
 * 
 * @param {string} [baseDir]
 * @returns {Object[]}
 */
export function readPendingIncidents(baseDir = DEFAULT_DIR) {
  const { pending } = getIncidentFilePaths(baseDir);
  if (!fs.existsSync(pending)) return [];

  const content = fs.readFileSync(pending, 'utf8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const records = [];

  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      console.warn('[IncidentStore] Malformed line in pending incidents:', e.message);
    }
  }

  return records;
}

/**
 * Read all processed incidents from runtime_incidents.processed.jsonl.
 * 
 * @param {string} [baseDir]
 * @returns {Object[]}
 */
export function readProcessedIncidents(baseDir = DEFAULT_DIR) {
  const { processed } = getIncidentFilePaths(baseDir);
  if (!fs.existsSync(processed)) return [];

  const content = fs.readFileSync(processed, 'utf8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const records = [];

  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      console.warn('[IncidentStore] Malformed line in processed incidents:', e.message);
    }
  }

  return records;
}

/**
 * Acknowledge incidents by IDs: moves them from pending to processed JSONL file.
 * 
 * @param {string[]} incidentIds
 * @param {Object} [triageMeta] optional metadata added when acknowledging
 * @param {string} [baseDir]
 * @returns {{ acknowledgedCount: number, remainingCount: number }}
 */
export function acknowledgeIncidents(incidentIds, triageMeta = {}, baseDir = DEFAULT_DIR) {
  const { pending, processed } = getIncidentFilePaths(baseDir);
  const idsSet = new Set(incidentIds || []);
  if (idsSet.size === 0) {
    return { acknowledgedCount: 0, remainingCount: readPendingIncidents(baseDir).length };
  }

  const allPending = readPendingIncidents(baseDir);
  const toProcess = [];
  const toKeep = [];

  const ackTimestamp = new Date().toISOString();
  for (const item of allPending) {
    if (idsSet.has(item.incidentId)) {
      toProcess.push({
        ...item,
        triagedAt: ackTimestamp,
        triageMeta
      });
    } else {
      toKeep.push(item);
    }
  }

  if (toProcess.length > 0) {
    const processedLines = toProcess.map(item => JSON.stringify(item)).join('\n') + '\n';
    fs.appendFileSync(processed, processedLines, 'utf8');
  }

  const remainingContent = toKeep.length > 0 ? toKeep.map(item => JSON.stringify(item)).join('\n') + '\n' : '';
  fs.writeFileSync(pending, remainingContent, 'utf8');

  return {
    acknowledgedCount: toProcess.length,
    remainingCount: toKeep.length
  };
}
