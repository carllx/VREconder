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

export function validateAuthorizationBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, error: 'Authorization bundle is missing or not an object' };
  }
  if (bundle.manifestSha256 !== FROZEN_MANIFEST_SHA256) {
    return { ok: false, error: `Manifest SHA256 mismatch: expected ${FROZEN_MANIFEST_SHA256}, got ${bundle.manifestSha256}` };
  }
  if (bundle.resultsSha256 !== FROZEN_RESULTS_SHA256) {
    return { ok: false, error: `Results SHA256 mismatch: expected ${FROZEN_RESULTS_SHA256}, got ${bundle.resultsSha256}` };
  }
  if (!Array.isArray(bundle.authorizedItems) || bundle.authorizedItems.length !== AUTHORIZED_EXACT_FILE_GROUP_IDS.length) {
    return { ok: false, error: `Expected ${AUTHORIZED_EXACT_FILE_GROUP_IDS.length} authorized items, got ${bundle.authorizedItems?.length}` };
  }

  const authorizedSet = new Set(AUTHORIZED_EXACT_FILE_GROUP_IDS);
  const bundleSet = new Set(bundle.authorizedItems.map(it => it.groupId));

  for (const gid of authorizedSet) {
    if (!bundleSet.has(gid)) {
      return { ok: false, error: `Missing authorized groupId in bundle: ${gid}` };
    }
  }

  for (const it of bundle.authorizedItems) {
    if (!authorizedSet.has(it.groupId)) {
      return { ok: false, error: `Unauthorized groupId found in bundle: ${it.groupId}` };
    }
  }

  return { ok: true };
}

export function loadExactFileAuthorizationBundle(bundlePath) {
  try {
    if (!fs.existsSync(bundlePath)) {
      return { ok: false, error: `Authorization bundle file not found: ${bundlePath}` };
    }
    const raw = fs.readFileSync(bundlePath, 'utf8');
    const parsed = JSON.parse(raw);
    const valid = validateAuthorizationBundle(parsed);
    if (!valid.ok) return valid;
    return { ok: true, bundle: parsed };
  } catch (err) {
    return { ok: false, error: `Failed to load authorization bundle: ${err.message}` };
  }
}

export class ExactFileAuthorizer {
  constructor(options = {}) {
    this.bundle = options.bundle || null;
    this.bundlePath = options.bundlePath || path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_exact_file_authorization.json');
    this.initialized = false;
    this.itemsByPath = new Map();
    this.itemsByGroupId = new Map();

    if (this.bundle) {
      this._initFromBundle(this.bundle);
    }
  }

  initialize() {
    if (this.initialized) return { ok: true };
    if (!this.bundle) {
      const loaded = loadExactFileAuthorizationBundle(this.bundlePath);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      this.bundle = loaded.bundle;
    }
    return this._initFromBundle(this.bundle);
  }

  _initFromBundle(bundle) {
    const valid = validateAuthorizationBundle(bundle);
    if (!valid.ok) return valid;

    this.itemsByPath.clear();
    this.itemsByGroupId.clear();

    for (const item of bundle.authorizedItems) {
      const normPath = path.normalize(path.resolve(item.canonicalPath));
      this.itemsByPath.set(normPath, item);
      this.itemsByGroupId.set(item.groupId, item);
    }
    this.initialized = true;
    return { ok: true };
  }

  resolveExactFileRepairRule(canonicalPath, facts, currentFingerprint) {
    if (!this.initialized) {
      const initResult = this.initialize();
      if (!initResult.ok) return null;
    }

    if (!canonicalPath || !facts || !currentFingerprint) return null;

    const normPath = path.normalize(path.resolve(canonicalPath));
    const authItem = this.itemsByPath.get(normPath);
    if (!authItem) return null;

    if (EXCLUDED_EXACT_FILE_GROUP_IDS.includes(authItem.groupId)) {
      return null;
    }

    const expected = authItem.expectedFingerprint;
    if (!expected) return null;
    if (expected.sizeBytes !== currentFingerprint.sizeBytes) return null;
    if (expected.fingerprintId && currentFingerprint.fingerprintId && expected.fingerprintId !== currentFingerprint.fingerprintId) {
      return null;
    }

    if (facts.videoCount !== 1 || facts.audioCount !== 1) return null;
    if (facts.otherStreams && facts.otherStreams.length > 0) return null;
    if (facts.chapterCount && facts.chapterCount > 0) return null;

    const v = facts.video;
    if (!v) return null;
    if ((v.codec || '').toLowerCase() !== 'hevc') return null;
    if ((v.codecTag || '').toLowerCase() !== 'hev1') return null;

    const op = authItem.authorizedRepairOperation || {
      type: 'stream-copy',
      ffmpegArgs: ['-map', '0', '-c', 'copy', '-tag:v', 'hvc1'],
      outputTag: 'hvc1'
    };

    return {
      ruleId: `exact-file-physical-cert-${authItem.groupId.toLowerCase()}`,
      name: `Exact File Physical Certified Stream-Copy (${authItem.groupId})`,
      policyVersion: 'v1.0.0-issue-21-exact-file-certified',
      status: RuleStatus.CERTIFIED_FOR_EXACT_FILE,
      groupId: authItem.groupId,
      canonicalPath: normPath,
      operation: op,
      expectedOutputTag: op.outputTag || 'hvc1',
      isExactFileCertified: true
    };
  }
}
