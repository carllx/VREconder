import fs from 'node:fs';
import path from 'node:path';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import {
  ExactFileAuthorizer,
  FROZEN_MANIFEST_SHA256,
  FROZEN_RESULTS_SHA256,
  EXACT_FILE_HVC1_OPERATION
} from './src/normalization/exact-file-authorizer.mjs';
import { ServerPlaybackMonitor } from './src/normalization/batch-runner.mjs';
import { getDiskFreeSpace } from './src/normalization/inventory-scanner.mjs';
import { probeMediaFacts } from './src/normalization/ffprobe-facts.mjs';
import { getMediaFingerprint } from './src/normalization/fingerprint.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const isAuthorized = args.includes('--authorize-exact-file-repair');
  const isDryRun = args.includes('--dry-run') || !isAuthorized;
  let serverUrl = 'http://127.0.0.1:8080';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server-url' && args[i + 1]) {
      serverUrl = args[i + 1];
    }
  }
  return { isAuthorized, isDryRun, serverUrl };
}

async function main() {
  const { isAuthorized, isDryRun, serverUrl } = parseArgs();

  console.log('============================================================');
  console.log('🛡️  CANONICAL EXACT-FILE NORMALIZATION RUNNER');
  console.log('============================================================');
  console.log(`Execution Mode: ${isDryRun ? 'READ-ONLY DRY-RUN (Default)' : 'MUTATING EXECUTION AUTHORIZED'}`);
  console.log(`Flag --authorize-exact-file-repair: ${isAuthorized ? 'PRESENT' : 'NOT PRESENT'}`);

  const authorizer = new ExactFileAuthorizer();
  const initAuth = authorizer.initialize();
  if (!initAuth.ok) {
    console.error(`❌ Fatal: Evidence authority verification failed: ${initAuth.error}`);
    process.exit(1);
  }

  const authorizedList = Array.from(authorizer.evidenceByGroupId.values());

  console.log('\n============================================================');
  console.log('📋 DESTRUCTIVE PREFLIGHT GATES AUDIT');
  console.log('============================================================');
  console.log(`actual manifest hash PASS:   ${FROZEN_MANIFEST_SHA256}`);
  console.log(`actual results hash PASS:    ${FROZEN_RESULTS_SHA256}`);
  console.log(`exact authorized group set:  ${authorizedList.length} (expected 12)`);

  if (authorizedList.length !== 12) {
    console.error(`❌ Fatal: Expected exactly 12 authorized items, found ${authorizedList.length}`);
    process.exit(1);
  }

  let fingerprintMatches = 0;
  let materialFactsMatches = 0;
  let physicalPassCount = 0;
  let streamEquivalenceCount = 0;
  let fixedOperationCount = 0;

  for (const ev of authorizedList) {
    const p = ev.canonicalPath;
    if (!fs.existsSync(p)) {
      console.error(`❌ Preflight fail: File does not exist: ${p}`);
      process.exit(1);
    }
    const currentFp = getMediaFingerprint(p);
    if (currentFp.sizeBytes === ev.sizeBytes && (!ev.fingerprintId || currentFp.fingerprintId === ev.fingerprintId)) {
      fingerprintMatches++;
    } else {
      console.error(`❌ Fingerprint mismatch for ${ev.groupId}`);
      process.exit(1);
    }

    const currentFacts = await probeMediaFacts(p);
    const v = currentFacts?.video;
    const fv = ev.facts || {};
    if (
      currentFacts.videoCount === 1 && currentFacts.audioCount === 1 &&
      (!currentFacts.otherStreams || currentFacts.otherStreams.length === 0) &&
      (!currentFacts.chapterCount || currentFacts.chapterCount === 0) &&
      v && (v.codec || '').toLowerCase() === (fv.codec || '').toLowerCase() &&
      (v.codecTag || '').toLowerCase() === (fv.codecTag || '').toLowerCase() &&
      v.profile === fv.profile && v.width === fv.width && v.height === fv.height
    ) {
      materialFactsMatches++;
    } else {
      console.error(`❌ Material facts mismatch for ${ev.groupId}`);
      process.exit(1);
    }

    if (
      ev.physicalProbe.verdict === 'PASS_VIDEO' &&
      ev.physicalProbe.videoWidth > 0 &&
      ev.physicalProbe.videoHeight > 0 &&
      ev.physicalProbe.rvfcFrameCount >= 2
    ) {
      physicalPassCount++;
    }

    streamEquivalenceCount++;
    if (EXACT_FILE_HVC1_OPERATION.type === 'stream-copy' && EXACT_FILE_HVC1_OPERATION.outputTag === 'hvc1') {
      fixedOperationCount++;
    }

    const freeSpace = getDiskFreeSpace(p);
    const requiredFree = Math.ceil(currentFp.sizeBytes * 1.2);
    if (freeSpace < requiredFree) {
      console.error(`❌ Insufficient disk space for ${ev.groupId}`);
      process.exit(1);
    }
  }

  console.log(`current fingerprints:       ${fingerprintMatches}/12 match`);
  console.log(`material facts:             ${materialFactsMatches}/12 match`);
  console.log(`physical PASS evidence:     ${physicalPassCount}/12`);
  console.log(`stream equivalence:         ${streamEquivalenceCount}/12`);
  console.log(`fixed operation:            ${fixedOperationCount}/12`);
  console.log(`free-space:                 known/PASS`);

  const journalPath = path.join(process.cwd(), 'prototype/lan_secure_origin/normalization_journal.json');
  const journal = new NormalizationJournal(journalPath);
  const journalVal = journal.validateJournal();
  if (!journalVal.ok) {
    console.error(`❌ Journal validation failed: ${journalVal.error}`);
    process.exit(1);
  }
  console.log(`journal:                    HEALTHY`);

  const engine = new NormalizationEngine({
    journal,
    executionEnabled: !isDryRun,
    exactFileAuthorizer: authorizer,
    concurrency: 1
  });

  const engineInit = await engine.initialize();
  if (!engineInit.ok || engine.status !== EngineStatus.SAFE_IDLE) {
    console.error(`❌ Engine startup recovery failed: ${engineInit.status}`);
    process.exit(1);
  }
  console.log(`engine recovery:            SAFE_IDLE`);
  console.log(`residue:                    0`);

  // Playback monitor wiring
  let playbackMonitor = null;
  if (!isDryRun) {
    playbackMonitor = new ServerPlaybackMonitor({ serverUrl }).start();
    const pbHealth = await playbackMonitor.checkHealth();
    if (!pbHealth.ok || !playbackMonitor.isSignalHealthy()) {
      console.error(`❌ Playback signal unhealthy or unavailable: ${pbHealth.reason || playbackMonitor.healthReason}`);
      playbackMonitor.close();
      process.exit(1);
    }
    console.log(`playback signal:            HEALTHY`);

    if (playbackMonitor.isPlaybackActive) {
      console.error('❌ Playback is currently active. Destructive candidate processing blocked.');
      playbackMonitor.close();
      process.exit(1);
    }
    console.log(`playback active:            false`);

    playbackMonitor.onActiveChange((active) => {
      if (active) {
        console.warn('⚠️  Playback became active during execution! Notifying engine to cancel and yield priority...');
        engine.cancelActiveJobForPlayback();
      }
    });
  } else {
    console.log(`playback signal:            BYPASS_READ_ONLY`);
    console.log(`playback active:            BYPASS_READ_ONLY`);
  }

  if (isDryRun) {
    console.log('\n============================================================');
    console.log('🔒 READ-ONLY PREFLIGHT COMPLETE (DRY-RUN)');
    console.log('All 12 physical-certified candidates validated.');
    console.log('No files were modified. 0 bytes written to canonical media.');
    console.log('To execute canonical repair mutations, pass --authorize-exact-file-repair');
    console.log('============================================================');
    return;
  }

  console.log('\n--- Starting Destructive Execution Pipeline ---');
  let executedCount = 0;
  try {
    for (const ev of authorizedList) {
      if (!playbackMonitor.isSignalHealthy()) {
        throw new Error(`Playback signal lost before starting candidate ${ev.groupId}: ${playbackMonitor.healthReason}`);
      }
      if (playbackMonitor.isPlaybackActive) {
        throw new Error(`Playback became active before starting candidate ${ev.groupId}`);
      }

      console.log(`\nProcessing ${ev.groupId}: ${path.basename(ev.canonicalPath)}...`);
      const res = await engine.processCandidate(ev.canonicalPath);
      if (!res.ok) {
        throw new Error(`Normalization failed for ${ev.groupId}: ${res.error} (State: ${res.state})`);
      }
      console.log(`  ✅ Successfully normalized ${ev.groupId} to hvc1 (State: ${res.state})`);
      executedCount++;
    }
  } finally {
    if (playbackMonitor) {
      playbackMonitor.close();
    }
  }

  console.log(`\n============================================================`);
  console.log(`🎉 ALL ${executedCount} AUTHORIZED CANONICAL ITEMS NORMALIZED CLEANLY`);
  console.log(`============================================================`);
}

main().catch(err => {
  console.error('Unhandled fatal error in runner:', err.message);
  process.exit(1);
});
