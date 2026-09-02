import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BatchNormalizationRunner, ServerPlaybackMonitor, derivePendingQueue } from './src/normalization/batch-runner.mjs';
import { NormalizationJournal } from './src/normalization/journal.mjs';
import { verifyAuthorizationUniverse, DEFAULT_MANIFEST_PATH } from './src/normalization/authorization-manifest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_INVENTORY = path.join(__dirname, 'scanned_raw_library.json');
const DEFAULT_JOURNAL = path.join(__dirname, 'normalization_journal.json');
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080';

async function main() {
  const args = process.argv.slice(2);
  const authorizeExecution = args.includes('--authorize-batch-execution');
  const dryRunOnly = args.includes('--dry-run') || !authorizeExecution;

  let inventoryPath = DEFAULT_INVENTORY;
  let customInventorySpecified = false;
  const invIdx = args.indexOf('--inventory');
  if (invIdx !== -1 && args[invIdx + 1]) {
    inventoryPath = path.resolve(args[invIdx + 1]);
    if (path.normalize(inventoryPath) !== path.normalize(DEFAULT_INVENTORY)) {
      customInventorySpecified = true;
    }
  }

  if (authorizeExecution && customInventorySpecified) {
    console.error('❌ SAFETY VIOLATION: Custom --inventory override is strictly prohibited in destructive authorization mode.');
    console.error('   Human authorization scope is locked to the accepted canonical universe:');
    console.error(`   ${DEFAULT_INVENTORY}`);
    process.exit(1);
  }

  let serverUrl = DEFAULT_SERVER_URL;
  const srvIdx = args.indexOf('--server-url');
  if (srvIdx !== -1 && args[srvIdx + 1]) {
    serverUrl = args[srvIdx + 1];
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node run_batch_normalization.mjs [options]');
    console.log('');
    console.log('Options:');
    console.log('  --authorize-batch-execution   Enable destructive normalization (default: disabled)');
    console.log('  --dry-run                     Run in read-only inspection mode (default)');
    console.log('  --inventory <path>            Path to scanned library inventory (default: scanned_raw_library.json)');
    console.log('  --server-url <url>            URL of running VR server for playback priority (default: http://127.0.0.1:8080)');
    console.log('  --help                        Show this help message');
    return;
  }

  console.log('============================================================');
  console.log('📦 BATCH NORMALIZATION QUEUE CONTROLLER');
  console.log(`   Execution Mode: ${authorizeExecution ? 'AUTHORIZED DESTRUCTIVE ROLLOUT' : 'DRY RUN (READ-ONLY)'}`);
  console.log(`   Inventory:      ${inventoryPath}`);
  console.log(`   Server Signal:  ${serverUrl}`);
  console.log('============================================================\n');

  if (!fs.existsSync(inventoryPath)) {
    console.error(`❌ Inventory file not found at: ${inventoryPath}`);
    process.exit(1);
  }

  const journal = new NormalizationJournal(DEFAULT_JOURNAL);
  const playbackMonitor = new ServerPlaybackMonitor({ serverUrl }).start();

  console.log('🔍 Deriving active pending queue from accepted exact-certified universe...');
  const queuePlan = await derivePendingQueue({
    inventoryPath,
    journal
  });

  console.log(`\nCandidate Scope Analysis:`);
  console.log(`  Accepted Certified Universe: ${queuePlan.totalAcceptedUniverse}`);
  console.log(`  Already Completed (DONE):   ${queuePlan.alreadyCompleted.length}`);
  console.log(`  Pending Rollout Queue:      ${queuePlan.pendingQueue.length}`);
  console.log(`  Excluded / Non-Candidate:   ${queuePlan.skippedOrExcluded.length}\n`);

  if (dryRunOnly) {
    console.log('🔒 SAFETY GATE ENGAGED: Dry-run inspection complete.');
    console.log('   Global executionEnabled remains false.');
    console.log('   To authorize destructive rollout, run with: --authorize-batch-execution\n');
    playbackMonitor.close();
    return;
  }

  if (authorizeExecution) {
    console.log('🔒 Verifying authorization manifest and accepted universe identity...');
    const authCheck = verifyAuthorizationUniverse({
      manifestPath: DEFAULT_MANIFEST_PATH,
      inventoryPath
    });
    if (!authCheck.ok) {
      console.error(`❌ AUTHORIZATION UNIVERSE IDENTITY LOCK FAILED: ${authCheck.reason}`);
      console.error(`   Details: ${authCheck.error || '--'}`);
      playbackMonitor.close();
      process.exit(1);
    }
    console.log(`✅ Authorization universe identity verified (${authCheck.count} items, digest ${authCheck.universeDigest.slice(0, 12)}...)\n`);
  }

  console.log('🚀 Initializing BatchNormalizationRunner (executionEnabled: true)...');
  const runner = new BatchNormalizationRunner({
    journal,
    executionEnabled: true,
    playbackMonitor,
    verifyAuthorizationManifest: true,
    manifestPath: DEFAULT_MANIFEST_PATH,
    inventoryPath,
    onProgress: (prog, formatted) => {
      console.log(`\n--- Queue Progress ---`);
      console.log(formatted);
    }
  });

  const report = await runner.runQueue(queuePlan.pendingQueue, {
    alreadyCompleted: queuePlan.alreadyCompleted
  });

  playbackMonitor.close();

  const reportPath = path.join(__dirname, 'batch_rollout_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n============================================================`);
  console.log(`BATCH ROLLOUT FINISHED. Final Status: ${report.status}`);
  console.log(`Report saved to: ${reportPath}`);
  console.log(`============================================================`);
}

main().catch((err) => {
  console.error('\n❌ Fatal error in batch runner:', err);
  process.exit(1);
});
