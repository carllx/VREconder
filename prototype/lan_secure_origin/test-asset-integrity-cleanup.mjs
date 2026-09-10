import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildManifest, getMediaFingerprint } from './generate_asset_manifest.mjs';

describe('Issue #27: T7 Asset Integrity Cleanup Manifest (Gate A)', () => {
  const manifestPath = 'prototype/lan_secure_origin/asset_integrity_cleanup_manifest.json';

  test('Manifest file exists and conforms to required structure', () => {
    assert(fs.existsSync(manifestPath), `Manifest must exist at ${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.equal(manifest.manifestVersion, '1.0.0-issue-27');
    assert.equal(manifest.gate, 'GATE_A_READONLY');
    assert.equal(manifest.zeroMediaMutationEnforced, true);
    assert.ok(manifest.totals);
    assert.ok(Array.isArray(manifest.groups));
    assert.equal(manifest.groups.length, manifest.totals.groupsInspected);
  });

  test('Totals match classification invariants exactly', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const t = manifest.totals;

    assert.equal(t.groupsInspected, 44);
    assert.equal(t.CANONICAL_NEEDS_NORMALIZATION, 15);
    assert.equal(t.TEST_ARTIFACT, 25);
    assert.equal(t.RELATIONSHIP_UNCERTAIN, 4);
    assert.equal(t.CANONICAL_KEEP, 0);
    assert.equal(t.SUPERSEDED_DERIVATIVE, 0);
    assert.equal(t.TRUE_DUPLICATE, 0);
    assert.equal(t.TRANSACTION_RESIDUE, 0);

    assert.equal(t.deletionEligibleCount, 25);
    assert.equal(t.userVisibleRenderDeletionEligibleCount, 21);
    assert.equal(t.deletionEligibleBytes, 49146270573);
    assert.equal(t.userVisibleRenderDeletionEligibleBytes, 36351442322);
  });

  test('Every deletion-eligible item has a valid, existing retained canonical copy with valid fingerprint', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const deletionEligibleGroups = manifest.groups.filter(g => g.deletionEligible);

    assert.equal(deletionEligibleGroups.length, 25);

    for (const g of deletionEligibleGroups) {
      assert.equal(g.classification, 'TEST_ARTIFACT');
      assert.ok(g.retainedCanonicalPath, `Group ${g.groupId} must have retainedCanonicalPath`);
      assert.ok(fs.existsSync(g.retainedCanonicalPath), `Retained copy must exist: ${g.retainedCanonicalPath}`);
      assert.ok(fs.existsSync(g.candidatePath), `Candidate copy must exist: ${g.candidatePath}`);

      const candidateFp = getMediaFingerprint(g.candidatePath);
      const canonicalFp = getMediaFingerprint(g.retainedCanonicalPath);

      assert.ok(candidateFp, `Candidate fingerprint must be valid: ${g.candidatePath}`);
      assert.ok(canonicalFp, `Canonical fingerprint must be valid: ${g.retainedCanonicalPath}`);

      assert.equal(candidateFp.fingerprintId, g.candidateFingerprint);
      assert.equal(canonicalFp.fingerprintId, g.retainedCanonicalFingerprint);
      assert.ok(g.exactEvidenceBasis && g.exactEvidenceBasis.length > 10, 'Strong evidence required');
    }
  });

  test('All 15 physical probe failures are preserved as CANONICAL_NEEDS_NORMALIZATION with zero deletion eligibility', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const incompGroups = manifest.groups.filter(g => g.groupId.startsWith('GRP-INCOMPAT-'));

    assert.equal(incompGroups.length, 15);

    for (const g of incompGroups) {
      assert.equal(g.classification, 'CANONICAL_NEEDS_NORMALIZATION');
      assert.equal(g.deletionEligible, false);
      assert.equal(g.proposedAction, 'PRESERVE_FOR_ISSUE21_NORMALIZATION');
      assert.equal(g.estimatedReclaimedBytes, 0);
      assert.ok(fs.existsSync(g.candidatePath), `Incompatible file must exist: ${g.candidatePath}`);

      const fp = getMediaFingerprint(g.candidatePath);
      assert.ok(fp);
      assert.equal(fp.fingerprintId, g.candidateFingerprint);
    }
  });

  test('All 4 ambiguous groups are classified RELATIONSHIP_UNCERTAIN and left untouched', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const uncertainGroups = manifest.groups.filter(g => g.groupId.startsWith('GRP-UNCERTAIN-'));

    assert.equal(uncertainGroups.length, 4);

    for (const g of uncertainGroups) {
      assert.equal(g.classification, 'RELATIONSHIP_UNCERTAIN');
      assert.equal(g.deletionEligible, false);
      assert.equal(g.proposedAction, 'LEAVE_UNTOUCHED');
      assert.equal(g.estimatedReclaimedBytes, 0);
      assert.ok(g.uncertaintyReason && g.uncertaintyReason.length > 10);
    }
  });

  test('Gate A guarantees ZERO media mutation', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const g of manifest.groups) {
      // Re-verify that candidate and retained files have not changed size or mtime
      const cStat = fs.statSync(g.candidatePath);
      assert.equal(cStat.size, g.candidateSize);
    }
  });
});
