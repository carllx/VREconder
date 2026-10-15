import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default store path in prototype/lan_secure_origin
const DEFAULT_STORE_PATH = path.resolve(__dirname, '../../provisional_playback_admissions.json');

export const PROVISIONAL_EVIDENCE_CATEGORY = 'USER_REPORTED_DEVICE_PASS';

/**
 * Hardcoded initial list of user-verified files for provisional admission.
 * Exactly binds to current canonical path and exact file fingerprint.
 */
export const DEFAULT_PROVISIONAL_ENTRIES = [
  {
    fingerprintId: '48488830469320d3',
    name: 'Anna Bella - Gallery Sweet Compensation - virtualtaboo.mp4',
    relativeHint: 'Anna Bella - Gallery Sweet Compensation - virtualtaboo.mp4',
    evidenceCategory: PROVISIONAL_EVIDENCE_CATEGORY,
    userReportedDate: '2026-10-12',
    notes: 'User-verified normal playback in iPhone 15 Pro Safari Direct mode'
  },
  {
    fingerprintId: 'd7ed4c1a61ee1e83',
    name: 'Agatha Vega - Czech VR - I\'m Here to Serve.mp4',
    relativeHint: 'Agatha Vega - Czech VR - I\'m Here to Serve.mp4',
    evidenceCategory: PROVISIONAL_EVIDENCE_CATEGORY,
    userReportedDate: '2026-10-12',
    notes: 'User-verified normal playback in iPhone 15 Pro Safari Direct mode'
  },
  {
    fingerprintId: 'bc6ef8f49633fa0e',
    name: 'Agatha Vega & Leya Desantis - SLR Originals - Euro Trip Rainy Day Fantasy.mp4',
    relativeHint: 'Agatha Vega & Leya Desantis - SLR Originals - Euro Trip Rainy Day Fantasy.mp4',
    evidenceCategory: PROVISIONAL_EVIDENCE_CATEGORY,
    userReportedDate: '2026-10-12',
    notes: 'User-verified normal playback in iPhone 15 Pro Safari Direct mode'
  },
  {
    fingerprintId: '31ec2ec5204250df',
    name: 'Hagawa Ruru - DSVR02007.mp4',
    relativeHint: 'Hagawa Ruru - DSVR02007.mp4',
    evidenceCategory: PROVISIONAL_EVIDENCE_CATEGORY,
    userReportedDate: '2026-10-12',
    notes: 'User-verified normal playback in iPhone 15 Pro Safari Direct mode'
  },
  {
    fingerprintId: 'ce726e729505a008',
    name: 'Shirohana Non - EBVR086.mp4',
    relativeHint: 'Shirohana Non - EBVR086.mp4',
    evidenceCategory: PROVISIONAL_EVIDENCE_CATEGORY,
    userReportedDate: '2026-10-12',
    notes: 'User-verified normal playback in iPhone 15 Pro Safari Direct mode'
  }
];

export class ProvisionalAdmissionStore {
  /**
   * @param {string} [storagePath]
   */
  constructor(storagePath = DEFAULT_STORE_PATH) {
    this.storagePath = path.resolve(storagePath);
    this.entries = new Map();
    this.loadFromDisk();
  }

  loadFromDisk() {
    this.entries.clear();
    if (!fs.existsSync(this.storagePath)) {
      // Fail-closed: missing file means 0 active provisional entries, never silently re-grant defaults
      return { ok: true, count: 0, reason: 'FILE_NOT_FOUND' };
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        const list = Array.isArray(raw) ? raw : (raw.admissions || []);
        for (const item of list) {
          if (item && item.fingerprintId) {
            this.entries.set(item.fingerprintId, item);
          }
        }
        return { ok: true, count: this.entries.size, reason: 'LOADED' };
      }
      return { ok: false, count: 0, reason: 'INVALID_PAYLOAD' };
    } catch (e) {
      // Fail-closed: corrupted JSON leaves entries empty, never mutates or seeds defaults
      console.warn(`[ProvisionalAdmissionStore] Corrupted or unreadable ${this.storagePath}: ${e.message}. Failing closed with 0 entries.`);
      return { ok: false, count: 0, reason: e.message };
    }
  }

  saveToDisk() {
    const payload = {
      version: '1.0.0',
      updatedAt: new Date().toISOString(),
      admissions: Array.from(this.entries.values())
    };
    const tmp = `${this.storagePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.storagePath);
  }

  /**
   * Check if a given fingerprint is in the provisional admission list.
   * @param {string} fingerprintId
   * @returns {object | null}
   */
  getAdmission(fingerprintId) {
    if (!fingerprintId) return null;
    return this.entries.get(fingerprintId) || null;
  }

  /**
   * List all current provisional admission entries.
   * @returns {object[]}
   */
  listAdmissions() {
    return Array.from(this.entries.values());
  }

  /**
   * Revoke provisional admission for a fingerprint with fail-safe disk persistence.
   * @param {string} fingerprintId
   * @returns {boolean}
   */
  revokeAdmission(fingerprintId) {
    if (!fingerprintId || !this.entries.has(fingerprintId)) return false;
    const previous = this.entries.get(fingerprintId);
    this.entries.delete(fingerprintId);
    try {
      this.saveToDisk();
      return true;
    } catch (err) {
      // Revert in-memory mutation to maintain parity with disk
      this.entries.set(fingerprintId, previous);
      throw new Error(`Failed to persist provisional admission revocation: ${err.message}`);
    }
  }

  /**
   * Add or update provisional admission with fail-safe disk persistence.
   * @param {object} item
   * @returns {object}
   */
  addAdmission(item) {
    if (!item || !item.fingerprintId) {
      throw new Error('fingerprintId is required for provisional admission');
    }
    const entry = {
      fingerprintId: item.fingerprintId,
      name: item.name || '',
      relativeHint: item.relativeHint || item.name || '',
      evidenceCategory: item.evidenceCategory || PROVISIONAL_EVIDENCE_CATEGORY,
      userReportedDate: item.userReportedDate || new Date().toISOString().split('T')[0],
      notes: item.notes || 'User-verified normal playback'
    };
    const previous = this.entries.get(entry.fingerprintId);
    this.entries.set(entry.fingerprintId, entry);
    try {
      this.saveToDisk();
      return entry;
    } catch (err) {
      // Revert in-memory mutation to maintain parity with disk
      if (previous) this.entries.set(entry.fingerprintId, previous);
      else this.entries.delete(entry.fingerprintId);
      throw new Error(`Failed to persist provisional admission: ${err.message}`);
    }
  }

  /**
   * Reset store to initial defaults.
   */
  resetToDefaults() {
    this.entries.clear();
    for (const item of DEFAULT_PROVISIONAL_ENTRIES) {
      this.entries.set(item.fingerprintId, { ...item });
    }
    this.saveToDisk();
  }
}

let defaultStoreInstance = null;
export function getProvisionalAdmissionStore(storagePath = DEFAULT_STORE_PATH) {
  if (!defaultStoreInstance || (storagePath && defaultStoreInstance.storagePath !== path.resolve(storagePath))) {
    defaultStoreInstance = new ProvisionalAdmissionStore(storagePath);
  }
  return defaultStoreInstance;
}
