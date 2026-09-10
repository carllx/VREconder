import fs from 'node:fs';
import path from 'node:path';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import { ExactFileAuthorizer, loadExactFileAuthorizationBundle } from './src/normalization/exact-file-authorizer.mjs';
import { getDiskFreeSpace } from './src/normalization/inventory-scanner.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const isAuthorized = args.includes('--authorize-exact-file-repair');
  const isDryRun = args.includes('--dry-run') || !isAuthorized;
  return { isAuthorized, isDryRun };
}

async function main() {
  const { isAuthorized, isDryRun } = parseArgs();

  console.log('============================================================');
  console.log('🛡️  CANONICAL EXACT-FILE NORMALIZATION RUNNER');
  console.log('============================================================');
  console.log(`Execution Mode: ${isDryRun ? 'READ-ONLY DRY-RUN (Default)' : 'MUTATING EXECUTION AUTHORIZED'}`);
  console.log(`Flag --authorize-exact-file-repair: ${isAuthorized ? 'PRESENT' : 'NOT PRESENT'}`);

  const bundlePath = path.join(process.cwd(), 'prototype/lan_secure_origin/canonical_exact_file_authorization.json');
  const bundleLoad = loadExactFileAuthorizationBundle(bundlePath);
  if (!bundleLoad.ok) {
    console.error(`❌ Fatal: Authorization bundle failed to load: ${bundleLoad.error}`);
    process.exit(1);
  }

  const bundle = bundleLoad.bundle;
  console.log(`\nAuthorization Bundle Loaded:`);
  console.log(`  Manifest SHA256: ${bundle.manifestSha256}`);
  console.log(`  Results SHA256:  ${bundle.resultsSha256}`);
  console.log(`  Total Authorized Items: ${bundle.totalAuthorized}`);
  console.log(`  Excluded Items: ${bundle.excludedGroupIds.map(x => x.groupId).join(', ')}`);

  const authorizer = new ExactFileAuthorizer({ bundle });
  const initAuth = authorizer.initialize();
  if (!initAuth.ok) {
    console.error(`❌ Fatal: Authorizer failed to initialize: ${initAuth.error}`);
    process.exit(1);
  }

  // Preflight check each authorized file on disk
  console.log('\n--- Preflighting 12 Exact Authorized Files ---');
  let preflightPassed = 0;
  for (const it of bundle.authorizedItems) {
    const p = it.canonicalPath;
    const exists = fs.existsSync(p);
    if (!exists) {
      console.error(`  ❌ [FAIL] ${it.groupId}: File not found: ${p}`);
      continue;
    }
    const stat = fs.statSync(p);
    const expectedFp = it.expectedFingerprint;
    if (stat.size !== expectedFp.sizeBytes) {
      console.error(`  ❌ [FAIL] ${it.groupId}: Size mismatch: expected ${expectedFp.sizeBytes}, got ${stat.size}`);
      continue;
    }
    const freeSpace = getDiskFreeSpace(p);
    const requiredFree = Math.ceil(stat.size * 1.2);
    if (freeSpace < requiredFree) {
      console.error(`  ❌ [FAIL] ${it.groupId}: Insufficient disk space: free ${freeSpace}, required ${requiredFree}`);
      continue;
    }
    console.log(`  ✅ [PASS] ${it.groupId}: Exists, size ${stat.size}, free space OK (${Math.round(freeSpace / 1024 / 1024 / 1024)}GB)`);
    preflightPassed++;
  }

  console.log(`\nPreflight summary: ${preflightPassed}/${bundle.authorizedItems.length} passed.`);
  if (preflightPassed !== bundle.authorizedItems.length) {
    console.error('❌ Preflight checks failed. Halting.');
    process.exit(1);
  }

  if (isDryRun) {
    console.log('\n============================================================');
    console.log('🔒 READ-ONLY PREFLIGHT COMPLETE (DRY-RUN)');
    console.log('No files were modified. 0 bytes written to canonical media.');
    console.log('To execute canonical repair mutations, pass --authorize-exact-file-repair');
    console.log('============================================================');
    return;
  }

  console.log('\n--- Starting Destructive Execution Pipeline ---');
  const journalPath = path.join(process.cwd(), 'prototype/lan_secure_origin/normalization_journal.json');
  const journal = new NormalizationJournal(journalPath);
  const engine = new NormalizationEngine({
    journal,
    executionEnabled: true,
    exactFileAuthorizer: authorizer,
    concurrency: 1
  });

  const engineInit = await engine.initialize();
  if (!engineInit.ok) {
    console.error(`❌ Engine initialization failed: ${engineInit.status}`);
    process.exit(1);
  }

  let executedCount = 0;
  for (const it of bundle.authorizedItems) {
    console.log(`\nProcessing ${it.groupId}: ${path.basename(it.canonicalPath)}...`);
    const res = await engine.processCandidate(it.canonicalPath);
    if (!res.ok) {
      console.error(`  ❌ Normalization failed for ${it.groupId}: ${res.error}`);
      console.error(`  State: ${res.state}`);
      process.exit(1);
    }
    console.log(`  ✅ Successfully normalized ${it.groupId} to hvc1 (State: ${res.state})`);
    executedCount++;
  }

  console.log(`\n============================================================`);
  console.log(`🎉 ALL ${executedCount} AUTHORIZED CANONICAL ITEMS NORMALIZED CLEANLY`);
  console.log(`============================================================`);
}

main().catch(err => {
  console.error('Unhandled fatal error in runner:', err);
  process.exit(1);
});
