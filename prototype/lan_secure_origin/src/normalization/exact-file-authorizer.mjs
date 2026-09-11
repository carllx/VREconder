import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RuleStatus } from './repair-rules.mjs';

export const FROZEN_MANIFEST_SHA256 = 'd8c384d2538328cb0163d04e90b119290fd02754d92e7b1af68685543da0aa65';
export const FROZEN_RESULTS_SHA256 = '04f92cc9f0f47c469223849d6d45e8e1f8e54c62d0840c7d713c0a9a2e44e344';

export const AUTHORIZED_EXACT_FILE_GROUP_IDS = Object.freeze([
  'GRP-INCOMPAT-002', 'GRP-INCOMPAT-003', 'GRP-INCOMPAT-004', 'GRP-INCOMPAT-005',
  'GRP-INCOMPAT-006', 'GRP-INCOMPAT-007', 'GRP-INCOMPAT-008', 'GRP-INCOMPAT-009',
  'GRP-INCOMPAT-010', 'GRP-INCOMPAT-011', 'GRP-INCOMPAT-013', 'GRP-INCOMPAT-014'
]);

export const EXCLUDED_EXACT_FILE_GROUP_IDS = Object.freeze([
  'GRP-INCOMPAT-001',
  'GRP-INCOMPAT-012',
  'GRP-INCOMPAT-015'
]);

export const EXACT_FILE_HVC1_OPERATION = Object.freeze({
  type: 'stream-copy',
  ffmpegArgs: Object.freeze(['-map', '0', '-c', 'copy', '-tag:v', 'hvc1']),
  outputTag: 'hvc1',
  requiresReencoding: false
});

/**
 * Computes SHA-256 hash of a file on disk.
 * @param {string} filePath
 * @returns {string}
 */
export function computeFileSha256(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Loads and verifies actual manifest and results evidence files against frozen SHA-256 constants.
 * Derives authoritative evidence map for the exact 12 authorized groups.
 * Fails closed on any corruption, missing file, hash mismatch, or contract violation.
 * 
 * @param {object} options
 * @returns {{ ok: boolean, evidenceByPath?: Map, evidenceByGroupId?: Map, error?: string }}
 */
export function loadVerifiedEvidence(options = {}) {
  const manifestPath = options.manifestPath || path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_repair_manifest.json');
  const resultsPath = options.resultsPath || path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_repair_probe_results.jsonl');

  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `Canonical repair manifest file not found: ${manifestPath}` };
  }
  if (!fs.existsSync(resultsPath)) {
    return { ok: false, error: `Canonical repair probe results file not found: ${resultsPath}` };
  }

  let actualManifestSha;
  let actualResultsSha;
  try {
    actualManifestSha = computeFileSha256(manifestPath);
    actualResultsSha = computeFileSha256(resultsPath);
  } catch (err) {
    return { ok: false, error: `Failed to compute evidence file hashes: ${err.message}` };
  }

  if (actualManifestSha !== FROZEN_MANIFEST_SHA256) {
    return { ok: false, error: `Actual manifest SHA256 mismatch: expected ${FROZEN_MANIFEST_SHA256}, got ${actualManifestSha}` };
  }
  if (actualResultsSha !== FROZEN_RESULTS_SHA256) {
    return { ok: false, error: `Actual results SHA256 mismatch: expected ${FROZEN_RESULTS_SHA256}, got ${actualResultsSha}` };
  }

  let manifestObj;
  let resultLines;
  try {
    manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const rawResults = fs.readFileSync(resultsPath, 'utf8').trim();
    resultLines = rawResults.split('\n').map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`Malformed JSONL at line ${idx + 1}: ${e.message}`);
      }
    });
  } catch (err) {
    return { ok: false, error: `Failed to parse evidence files: ${err.message}` };
  }

  if (!Array.isArray(manifestObj?.items)) {
    return { ok: false, error: 'Manifest items array is missing or invalid' };
  }

  // Group physical results by groupId and check for duplicates/completeness
  const resultsByGroup = new Map();
  for (const r of resultLines) {
    if (!r || typeof r !== 'object' || !r.groupId) {
      return { ok: false, error: 'Result record missing groupId' };
    }
    if (resultsByGroup.has(r.groupId)) {
      resultsByGroup.get(r.groupId).push(r);
    } else {
      resultsByGroup.set(r.groupId, [r]);
    }
  }

  const evidenceByPath = new Map();
  const evidenceByGroupId = new Map();

  for (const gid of AUTHORIZED_EXACT_FILE_GROUP_IDS) {
    const manifestItem = manifestObj.items.find(it => it.groupId === gid);
    if (!manifestItem) {
      return { ok: false, error: `Authorized groupId missing from manifest: ${gid}` };
    }

    // Enforce repair action and stream equivalence from manifest
    if (manifestItem.repairAction !== 'HVC1_STREAMCOPY_PROBE_REQUIRED') {
      return { ok: false, error: `Unexpected repairAction for ${gid}: ${manifestItem.repairAction}` };
    }
    const details = manifestItem.details || {};
    if (details.streamEquivalenceVerified !== true) {
      return { ok: false, error: `streamEquivalenceVerified not true for ${gid}` };
    }
    if (details.videoMd5Match !== true) {
      return { ok: false, error: `videoMd5Match not true for ${gid}` };
    }
    if (details.audioMd5Match !== true) {
      return { ok: false, error: `audioMd5Match not true for ${gid}` };
    }

    // Enforce exactly 1 matching physical result in probe results
    const groupResults = resultsByGroup.get(gid) || [];
    if (groupResults.length === 0) {
      return { ok: false, error: `Missing physical probe result for ${gid}` };
    }
    if (groupResults.length > 1) {
      return { ok: false, error: `Duplicate physical probe results found for ${gid} (count: ${groupResults.length})` };
    }

    const probe = groupResults[0];
    const probeDetails = probe.details || probe;
    if (probe.verdict !== 'PASS_VIDEO' || probeDetails.verdict !== 'PASS_VIDEO') {
      return { ok: false, error: `Physical result verdict is not PASS_VIDEO for ${gid}: ${probe.verdict}` };
    }
    if (typeof probeDetails.videoWidth !== 'number' || probeDetails.videoWidth <= 0) {
      return { ok: false, error: `Physical result videoWidth not positive for ${gid}: ${probeDetails.videoWidth}` };
    }
    if (typeof probeDetails.videoHeight !== 'number' || probeDetails.videoHeight <= 0) {
      return { ok: false, error: `Physical result videoHeight not positive for ${gid}: ${probeDetails.videoHeight}` };
    }
    if (typeof probeDetails.rvfcFrameCount !== 'number' || probeDetails.rvfcFrameCount < 2) {
      return { ok: false, error: `Physical result rvfcFrameCount < 2 for ${gid}: ${probeDetails.rvfcFrameCount}` };
    }

    const canonicalPath = path.normalize(path.resolve(manifestItem.canonicalPath));
    const evidence = {
      groupId: gid,
      canonicalPath,
      fingerprintId: manifestItem.fingerprintId,
      sizeBytes: manifestItem.sizeBytes,
      facts: manifestItem.facts,
      physicalProbe: {
        verdict: probe.verdict,
        videoWidth: probeDetails.videoWidth,
        videoHeight: probeDetails.videoHeight,
        rvfcFrameCount: probeDetails.rvfcFrameCount
      }
    };

    evidenceByPath.set(canonicalPath, evidence);
    evidenceByGroupId.set(gid, evidence);
  }

  return { ok: true, evidenceByPath, evidenceByGroupId };
}

/**
 * Validates authorization bundle against verified evidence.
 * Local bundle cannot supply paths, fingerprints, or operations; it must strictly match verified evidence.
 * 
 * @param {object} bundle
 * @param {Map} evidenceByGroupId
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateAuthorizationBundle(bundle, evidenceByGroupId) {
  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, error: 'Authorization bundle is missing or not an object' };
  }
  if (bundle.manifestSha256 !== FROZEN_MANIFEST_SHA256) {
    return { ok: false, error: `Bundle manifest SHA256 mismatch: expected ${FROZEN_MANIFEST_SHA256}, got ${bundle.manifestSha256}` };
  }
  if (bundle.resultsSha256 !== FROZEN_RESULTS_SHA256) {
    return { ok: false, error: `Bundle results SHA256 mismatch: expected ${FROZEN_RESULTS_SHA256}, got ${bundle.resultsSha256}` };
  }
  if (!Array.isArray(bundle.authorizedItems) || bundle.authorizedItems.length !== AUTHORIZED_EXACT_FILE_GROUP_IDS.length) {
    return { ok: false, error: `Expected ${AUTHORIZED_EXACT_FILE_GROUP_IDS.length} authorized items, got ${bundle.authorizedItems?.length}` };
  }

  if (evidenceByGroupId) {
    for (const item of bundle.authorizedItems) {
      const ev = evidenceByGroupId.get(item.groupId);
      if (!ev) {
        return { ok: false, error: `Bundle item groupId not in verified evidence: ${item.groupId}` };
      }
      const normBundlePath = path.normalize(path.resolve(item.canonicalPath));
      if (normBundlePath !== ev.canonicalPath) {
        return { ok: false, error: `Bundle path tampered for ${item.groupId}: expected ${ev.canonicalPath}, got ${normBundlePath}` };
      }
      const expFp = item.expectedFingerprint || {};
      if (expFp.sizeBytes !== ev.sizeBytes || (expFp.fingerprintId && expFp.fingerprintId !== ev.fingerprintId)) {
        return { ok: false, error: `Bundle expectedFingerprint tampered for ${item.groupId}` };
      }
    }
  }

  return { ok: true };
}

/**
 * ExactFileAuthorizer manages physical certification for exact canonical files.
 * Authoritative evidence is derived strictly from verified manifest and results.
 */
export class ExactFileAuthorizer {
  constructor(options = {}) {
    this.manifestPath = options.manifestPath || path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_repair_manifest.json');
    this.resultsPath = options.resultsPath || path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_repair_probe_results.jsonl');
    this.bundlePath = options.bundlePath || path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_exact_file_authorization.json');
    this.bundle = options.bundle || null;
    this.initialized = false;
    this.evidenceByPath = new Map();
    this.evidenceByGroupId = new Map();
  }

  initialize() {
    if (this.initialized) return { ok: true };

    const evLoad = loadVerifiedEvidence({
      manifestPath: this.manifestPath,
      resultsPath: this.resultsPath
    });
    if (!evLoad.ok) {
      return { ok: false, error: `Failed to verify runtime evidence files: ${evLoad.error}` };
    }

    this.evidenceByPath = evLoad.evidenceByPath;
    this.evidenceByGroupId = evLoad.evidenceByGroupId;

    if (this.bundle) {
      const val = validateAuthorizationBundle(this.bundle, this.evidenceByGroupId);
      if (!val.ok) return { ok: false, error: val.error };
    } else if (fs.existsSync(this.bundlePath)) {
      try {
        const raw = fs.readFileSync(this.bundlePath, 'utf8');
        const parsed = JSON.parse(raw);
        const val = validateAuthorizationBundle(parsed, this.evidenceByGroupId);
        if (!val.ok) return { ok: false, error: val.error };
        this.bundle = parsed;
      } catch (err) {
        return { ok: false, error: `Failed to load bundle: ${err.message}` };
      }
    }

    this.initialized = true;
    return { ok: true };
  }

  /**
   * Matches candidate against exact-file physical certification.
   * 
   * @param {string} canonicalPath
   * @param {object} facts
   * @param {object} currentFingerprint
   * @returns {object | null}
   */
  resolveExactFileRepairRule(canonicalPath, facts, currentFingerprint) {
    if (!this.initialized) {
      const initResult = this.initialize();
      if (!initResult.ok) return null;
    }

    if (!canonicalPath || !facts || !currentFingerprint) return null;

    const normPath = path.normalize(path.resolve(canonicalPath));
    const ev = this.evidenceByPath.get(normPath);
    if (!ev) return null;

    if (EXCLUDED_EXACT_FILE_GROUP_IDS.includes(ev.groupId)) {
      return null;
    }

    // Verify current fingerprint against verified evidence
    if (currentFingerprint.sizeBytes !== ev.sizeBytes) return null;
    if (ev.fingerprintId && currentFingerprint.fingerprintId && ev.fingerprintId !== currentFingerprint.fingerprintId) {
      return null;
    }

    // Material facts check against verified evidence facts
    const v = facts.video;
    if (!v) return null;
    if ((v.codec || '').toLowerCase() !== 'hevc') return null;
    if ((v.codecTag || '').toLowerCase() !== 'hev1') return null;

    const frozenFacts = ev.facts || {};
    if (frozenFacts.codec && (v.codec || '').toLowerCase() !== (frozenFacts.codec || '').toLowerCase()) return null;
    if (frozenFacts.codecTag && (v.codecTag || '').toLowerCase() !== (frozenFacts.codecTag || '').toLowerCase()) return null;
    if (frozenFacts.profile && v.profile !== frozenFacts.profile) return null;
    if (frozenFacts.width && v.width !== frozenFacts.width) return null;
    if (frozenFacts.height && v.height !== frozenFacts.height) return null;

    // Invariant stream checks
    if (facts.videoCount !== 1 || facts.audioCount !== 1) return null;
    if (facts.otherStreams && facts.otherStreams.length > 0) return null;
    if (facts.chapterCount && facts.chapterCount > 0) return null;

    return {
      ruleId: `exact-file-physical-cert-${ev.groupId.toLowerCase()}`,
      name: `Exact File Physical Certified Stream-Copy (${ev.groupId})`,
      policyVersion: 'v1.0.0-issue-21-exact-file-certified',
      status: RuleStatus.CERTIFIED_FOR_EXACT_FILE,
      groupId: ev.groupId,
      canonicalPath: normPath,
      operation: EXACT_FILE_HVC1_OPERATION,
      expectedOutputTag: EXACT_FILE_HVC1_OPERATION.outputTag,
      isExactFileCertified: true
    };
  }
}
