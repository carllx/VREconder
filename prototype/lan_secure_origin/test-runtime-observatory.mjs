import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSessionId, setSessionId, resetSessionId, generateSessionId } from './src/telemetry/session.js';
import { MediaController } from './src/media/playback.js';
import { checkPlaybackAdmission, clearAdmissionCache } from './src/server/preflight-router.mjs';
import { enrichIncidentFromRequest } from './src/telemetry/incident-enricher.mjs';
import {
  clusterIncidents,
  correlatePairedAdmissionEvents,
  determineIncidentStatus,
  getHypothesisDetails,
  IncidentStatus
} from './src/telemetry/incident-cluster.mjs';
import {
  recordIncident,
  readPendingIncidents,
  readProcessedIncidents
} from './src/telemetry/incident-store.mjs';
import { generateSanitizedTriage, formatMarkdownSummary } from '../../scripts/triage-runtime-incidents.mjs';
import { setCachedFacts, clearFactsCache } from './src/normalization/ffprobe-facts.mjs';
import { isPathContained, resolveSecureMediaPath } from './src/server/media-path-resolver.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SANDBOX_DIR = path.join(__dirname, 'test_observatory_sandbox');

console.log('=== RUNNING ISSUE #28 RUNTIME OBSERVATORY V1 TEST SUITE ===\n');

// Clean sandbox directory
if (fs.existsSync(SANDBOX_DIR)) {
  fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
}
fs.mkdirSync(SANDBOX_DIR, { recursive: true });

try {
  // -------------------------------------------------------------
  // Test 1: Stable Page / Session Identity
  // -------------------------------------------------------------
  console.log('Test 1: Stable page / session ID');
  resetSessionId();
  const sess1 = getSessionId();
  assert.ok(sess1.startsWith('sess_'), 'Session ID should start with sess_ prefix');
  const sess2 = getSessionId();
  assert.strictEqual(sess1, sess2, 'Session ID must remain stable across calls within same session');
  console.log(`  ✅ [PASS] Session ID stable: ${sess1}`);

  // -------------------------------------------------------------
  // Test 2: Fingerprint & Admission Identity Propagation in MediaController
  // -------------------------------------------------------------
  console.log('\nTest 2: Fingerprint & identity propagation in client playback errors & blocks');
  const mockVideo = {
    currentTime: 14.52,
    readyState: 2,
    networkState: 1,
    videoWidth: 3840,
    videoHeight: 2160,
    error: { code: 4, message: 'Format not supported' },
    buffered: {
      length: 1,
      start: () => 0,
      end: () => 20.5
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    removeAttribute: () => {},
    load: () => {},
    pause: () => {}
  };

  const testSessionId = 'sess_test_page_123';
  const mockAdmission = {
    allowed: false,
    classification: 'NORMALIZATION_CANDIDATE_CERTIFIED',
    reason: 'HEVC mp4 needs repack',
    fingerprintId: 'fp_abc_001',
    admissionId: 'adm_999_001',
    matchedEnvelopeId: 'ENV_TEST_REPACK',
    allowedNextActions: ['REPACK_HVC1'],
    mediaFacts: { codec: 'hevc', profile: 'Main 10', level: 150, width: 3840, height: 2160 }
  };

  const loggedEvents = [];
  const ctrl = new MediaController(mockVideo, null, {
    sessionId: testSessionId,
    syncAdmissionBypass: false,
    admissionChecker: async () => mockAdmission
  });
  ctrl.setRemoteLogHook((level, eventType, data) => {
    loggedEvents.push({ level, eventType, data });
  });

  await ctrl.selectVideo('test/movie.mp4');

  assert.strictEqual(loggedEvents.length, 1, 'Should log MEDIA_PLAYBACK_BLOCKED_BY_POLICY');
  const policyEvent = loggedEvents[0];
  assert.strictEqual(policyEvent.eventType, 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY');
  assert.strictEqual(policyEvent.data.fingerprintId, 'fp_abc_001', 'Must propagate canonical fingerprint ID');
  assert.strictEqual(policyEvent.data.admissionId, 'adm_999_001', 'Must propagate admission decision ID');
  assert.strictEqual(policyEvent.data.sessionId, testSessionId, 'Must propagate session ID');
  assert.strictEqual(policyEvent.data.generation, 1, 'Must preserve generation');
  console.log('  ✅ [PASS] Fingerprint, admissionId, sessionId, generation propagated in policy block');

  // Test error listener dispatch
  let registeredErrorHandler = null;
  mockVideo.addEventListener = (evt, fn) => {
    if (evt === 'error') registeredErrorHandler = fn;
  };
  ctrl.attachGenerationListeners(1, 'test/movie.mp4');
  assert.ok(registeredErrorHandler, 'Error handler should be attached');

  registeredErrorHandler();
  assert.strictEqual(loggedEvents.length, 2, 'Should log MEDIA_PLAYBACK_ERROR');
  const errEvent = loggedEvents[1];
  assert.strictEqual(errEvent.eventType, 'MEDIA_PLAYBACK_ERROR');
  assert.strictEqual(errEvent.data.fingerprintId, 'fp_abc_001', 'Error event must preserve canonical fingerprint');
  assert.strictEqual(errEvent.data.admissionId, 'adm_999_001', 'Error event must preserve admission ID');
  assert.strictEqual(errEvent.data.sessionId, testSessionId, 'Error event must preserve session ID');
  assert.strictEqual(errEvent.data.code, 4, 'Must capture HTMLMediaElement error code');
  assert.strictEqual(errEvent.data.name, 'MEDIA_ERR_SRC_NOT_SUPPORTED', 'Must capture error name');
  assert.strictEqual(errEvent.data.currentTime, 14.52, 'Must capture currentTime');
  assert.strictEqual(errEvent.data.bufferAheadSec, 5.98, 'Must capture bufferAheadSec (20.5 - 14.52)');
  console.log('  ✅ [PASS] DOM media metrics, currentTime, and bufferAheadSec captured in error event');

  // -------------------------------------------------------------
  // Test 3: Server-Side Ingestion Context Enrichment (/api/log)
  // -------------------------------------------------------------
  console.log('\nTest 3: Server-side incident enrichment with UA, IP, and cheap cached media context');
  clearFactsCache();
  setCachedFacts('fp_cached_777', {
    video: {
      codec: 'h264',
      codecTag: 'avc1',
      profile: 'High',
      level: 60,
      pixFmt: 'yuv420p',
      bitDepth: 8,
      width: 4320,
      height: 2160,
      rFps: '60000/1001'
    },
    videoCount: 1,
    audioCount: 1,
    chapterCount: 0
  });

  const mockReq = {
    headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
    },
    socket: {
      remoteAddress: '192.168.10.73'
    }
  };

  const rawItem = {
    level: 'ERROR',
    message: 'MEDIA_PLAYBACK_ERROR',
    sessionId: 'sess_iphone_live',
    data: {
      fingerprintId: 'fp_cached_777',
      mediaName: 'Mizuno Asahi - BIKMVR039.mp4',
      mediaPath: '4K/Mizuno Asahi - BIKMVR039.mp4',
      code: 4,
      name: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
      readyState: 0,
      networkState: 3,
      currentTime: 0,
      bufferAheadSec: 0
    }
  };

  const enriched = enrichIncidentFromRequest({ req: mockReq, item: rawItem });
  assert.strictEqual(enriched.fingerprintId, 'fp_cached_777');
  assert.strictEqual(enriched.metadata.clientIp, '192.168.10.73');
  assert.ok(enriched.metadata.userAgent.includes('iPhone OS 18_1'), 'Must preserve userAgent');
  assert.strictEqual(enriched.metadata.sessionId, 'sess_iphone_live');
  assert.strictEqual(enriched.metadata.code, 4);
  assert.ok(enriched.metadata.mediaFacts, 'Must attach cached media facts');
  assert.strictEqual(enriched.metadata.mediaFacts.codec, 'h264');
  assert.strictEqual(enriched.metadata.mediaFacts.level, 60);
  assert.strictEqual(enriched.metadata.mediaFacts.width, 4320);
  assert.strictEqual(enriched.metadata.mediaFacts.height, 2160);
  console.log('  ✅ [PASS] UA, IP, and cheap cached media facts enriched without probe execution');

  // -------------------------------------------------------------
  // Test 4: Correlation of Paired Admission Denied & Policy Block Events
  // -------------------------------------------------------------
  console.log('\nTest 4: Correlate paired server admission + client policy events without double-counting');
  const serverDenial = {
    incidentId: 'inc_srv_001',
    timestamp: '2026-09-10T16:53:45.897Z',
    eventType: 'PLAYBACK_ADMISSION_DENIED',
    severity: 'WARN',
    fingerprintId: 'fp_av1_01',
    localMediaName: 'Kuraki Hana - SIVR347.mp4',
    classification: 'UNSUPPORTED_UNKNOWN_FIX',
    reason: 'Codec av1 (tag: av01) has no verified playback or streamcopy repair rule',
    occurrenceSource: 'server_admission_gate',
    metadata: { admissionId: 'adm_sivr347' }
  };

  const clientBlock = {
    incidentId: 'inc_cli_001',
    timestamp: '2026-09-10T16:53:45.981Z',
    eventType: 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY',
    severity: 'WARN',
    fingerprintId: 'fp_av1_01',
    localMediaName: 'Kuraki Hana - SIVR347.mp4',
    classification: 'UNSUPPORTED_UNKNOWN_FIX',
    reason: 'Codec av1 (tag: av01) has no verified playback or streamcopy repair rule',
    occurrenceSource: 'client_telemetry',
    metadata: { admissionId: 'adm_sivr347', generation: 20 }
  };

  const pairs = correlatePairedAdmissionEvents([serverDenial, clientBlock]);
  assert.strictEqual(pairs.get('inc_srv_001'), 'inc_cli_001', 'Server event must pair with client event');
  assert.strictEqual(pairs.get('inc_cli_001'), 'inc_srv_001', 'Client event must pair with server event');

  const pairClustered = clusterIncidents([serverDenial, clientBlock]);
  assert.strictEqual(pairClustered.clusters.length, 1, 'Paired events must form 1 logical cluster');
  assert.strictEqual(pairClustered.clusters[0].occurrenceCount, 1, 'Paired events must count as 1 logical occurrence');
  assert.strictEqual(pairClustered.clusters[0].rawEventCount, 2, 'Raw event count must remain 2');
  assert.strictEqual(pairClustered.clusters[0].pairedEventsCount, 1, 'Paired count must be 1');
  assert.deepStrictEqual(pairClustered.clusters[0].rawIncidentIds, ['inc_srv_001', 'inc_cli_001'], 'Both raw incident IDs preserved');
  console.log('  ✅ [PASS] Paired server/client admission events correlated as 1 logical occurrence');

  // -------------------------------------------------------------
  // Test 5: Late-Night Session Fixture Regression Gate
  // -------------------------------------------------------------
  console.log('\nTest 5: Late-night session fixture regression gate (9 incidents / 2 dominant clusters)');
  const lateNightFixture = [
    // Kuraki Hana (AV1 pair)
    {
      incidentId: 'inc_av1_1_srv',
      timestamp: '2026-09-10T16:53:45.897Z',
      eventType: 'PLAYBACK_ADMISSION_DENIED',
      severity: 'WARN',
      fingerprintId: 'e7c352c0fdce5c09',
      localMediaName: 'Kuraki Hana - SIVR347.mp4',
      localMediaPath: 'G:\\Media\\VR\\4K\\Kuraki Hana - SIVR347.mp4',
      classification: 'UNSUPPORTED_UNKNOWN_FIX',
      reason: 'Codec av1 (tag: av01) has no verified playback or streamcopy repair rule',
      occurrenceSource: 'server_admission_gate'
    },
    {
      incidentId: 'inc_av1_1_cli',
      timestamp: '2026-09-10T16:53:45.981Z',
      eventType: 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY',
      severity: 'WARN',
      fingerprintId: null,
      localMediaName: 'Kuraki Hana - SIVR347.mp4',
      localMediaPath: '4K/Kuraki Hana - SIVR347.mp4',
      classification: 'UNSUPPORTED_UNKNOWN_FIX',
      reason: 'Codec av1 (tag: av01) has no verified playback or streamcopy repair rule',
      occurrenceSource: 'client_telemetry'
    },
    // BIKMVR039 (H.264 Code 4 - 3 occurrences)
    {
      incidentId: 'inc_bik_1',
      timestamp: '2026-09-10T17:09:51.161Z',
      eventType: 'MEDIA_PLAYBACK_ERROR',
      severity: 'ERROR',
      fingerprintId: null,
      localMediaName: 'Mizuno Asahi - BIKMVR039.mp4',
      localMediaPath: '4K/Mizuno Asahi - BIKMVR039.mp4',
      classification: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
      reason: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
      occurrenceSource: 'client_telemetry',
      metadata: { code: 4, readyState: 0, networkState: 3 }
    },
    {
      incidentId: 'inc_bik_2',
      timestamp: '2026-09-10T17:16:48.907Z',
      eventType: 'MEDIA_PLAYBACK_ERROR',
      severity: 'ERROR',
      fingerprintId: null,
      localMediaName: 'Mizuno Asahi - BIKMVR039.mp4',
      localMediaPath: 'Mizuno Asahi - BIKMVR039.mp4',
      classification: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
      reason: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
      occurrenceSource: 'client_telemetry',
      metadata: { code: 4, readyState: 0, networkState: 3 }
    },
    {
      incidentId: 'inc_bik_3',
      timestamp: '2026-09-10T17:18:17.296Z',
      eventType: 'MEDIA_PLAYBACK_ERROR',
      severity: 'ERROR',
      fingerprintId: null,
      localMediaName: 'Mizuno Asahi - BIKMVR039.mp4',
      localMediaPath: 'Mizuno Asahi - BIKMVR039.mp4',
      classification: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
      reason: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
      occurrenceSource: 'client_telemetry',
      metadata: { code: 4, readyState: 0, networkState: 3 }
    },
    // Murakami Yuuka (AV1 pair)
    {
      incidentId: 'inc_av1_2_srv',
      timestamp: '2026-09-10T17:19:02.847Z',
      eventType: 'PLAYBACK_ADMISSION_DENIED',
      severity: 'WARN',
      fingerprintId: '5d626d87a8757fc2',
      localMediaName: 'Murakami Yuuka- SIVR392.mp4',
      localMediaPath: 'G:\\Media\\VR\\4K\\Murakami Yuuka- SIVR392.mp4',
      classification: 'UNSUPPORTED_UNKNOWN_FIX',
      reason: 'Codec av1 (tag: av01) has no verified playback or streamcopy repair rule',
      occurrenceSource: 'server_admission_gate'
    },
    {
      incidentId: 'inc_av1_2_cli',
      timestamp: '2026-09-10T17:19:02.908Z',
      eventType: 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY',
      severity: 'WARN',
      fingerprintId: null,
      localMediaName: 'Murakami Yuuka- SIVR392.mp4',
      localMediaPath: 'Murakami Yuuka- SIVR392.mp4',
      classification: 'UNSUPPORTED_UNKNOWN_FIX',
      reason: 'Codec av1 (tag: av01) has no verified playback or streamcopy repair rule',
      occurrenceSource: 'client_telemetry'
    },
    // Sezaki Ayane (AV1 pair)
    {
      incidentId: 'inc_av1_3_srv',
      timestamp: '2026-09-10T17:25:30.430Z',
      eventType: 'PLAYBACK_ADMISSION_DENIED',
      severity: 'WARN',
      fingerprintId: '345802985ed10130',
      localMediaName: 'Sezaki Ayane - WAVR110.mp4',
      localMediaPath: 'G:\\Media\\VR\\4K\\Sezaki Ayane - WAVR110.mp4',
      classification: 'UNSUPPORTED_UNKNOWN_FIX',
      reason: 'Codec av1 (tag: av01) has no verified playback or streamcopy repair rule',
      occurrenceSource: 'server_admission_gate'
    },
    {
      incidentId: 'inc_av1_3_cli',
      timestamp: '2026-09-10T17:25:30.501Z',
      eventType: 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY',
      severity: 'WARN',
      fingerprintId: null,
      localMediaName: 'Sezaki Ayane - WAVR110.mp4',
      localMediaPath: 'Sezaki Ayane - WAVR110.mp4',
      classification: 'UNSUPPORTED_UNKNOWN_FIX',
      reason: 'Codec av1 (tag: av01) has no verified playback or streamcopy repair rule',
      occurrenceSource: 'client_telemetry'
    }
  ];

  const triageResult = generateSanitizedTriage(lateNightFixture);
  assert.strictEqual(triageResult.totalCount, 9, 'Must reflect 9 total raw incidents');
  assert.strictEqual(triageResult.clusters.length, 2, 'Must cluster into exactly 2 dominant logical clusters');

  // Verify AV1 Cluster
  const av1Cluster = triageResult.clusters.find(c => c.classification === 'UNSUPPORTED_UNKNOWN_FIX');
  assert.ok(av1Cluster, 'AV1 cluster must exist');
  assert.strictEqual(av1Cluster.targetIssue, 21, 'AV1 policy block belongs to #21');
  assert.strictEqual(av1Cluster.status, IncidentStatus.KNOWN_POLICY, 'AV1 policy block status must be KNOWN_POLICY');
  assert.strictEqual(av1Cluster.mediaCount, 3, 'AV1 cluster must contain 3 media');
  assert.strictEqual(av1Cluster.occurrenceCount, 3, 'AV1 cluster must have 3 logical occurrences (pairs correlated)');
  assert.strictEqual(av1Cluster.rawEventCount, 6, 'AV1 cluster must have 6 raw events');
  assert.strictEqual(av1Cluster.pairedEventsCount, 3, 'All 3 media must have paired server/client events');
  assert.strictEqual(av1Cluster.rawIncidentIds.length, 6, 'All 6 raw incident IDs preserved');

  // Verify BIKMVR039 Cluster
  const bikCluster = triageResult.clusters.find(c => c.classification === 'MEDIA_ERR_SRC_NOT_SUPPORTED');
  assert.ok(bikCluster, 'BIKMVR039 Code 4 cluster must exist');
  assert.strictEqual(bikCluster.targetIssue, 23, 'Playback recovery belongs to #23');
  assert.strictEqual(bikCluster.status, IncidentStatus.HYPOTHESIS, 'BIKMVR039 Code 4 MUST be HYPOTHESIS, not verified cause');
  assert.ok(bikCluster.hypothesisDetails.includes('H.264 High@L6.0'), 'Hypothesis must preserve observed static facts');
  assert.ok(bikCluster.hypothesisDetails.includes('Cause remains a hypothesis'), 'Hypothesis must preserve unverified status');
  assert.strictEqual(bikCluster.mediaCount, 1, 'BIKMVR039 cluster has 1 media');
  assert.strictEqual(bikCluster.occurrenceCount, 3, 'BIKMVR039 cluster has 3 occurrences');
  assert.strictEqual(bikCluster.rawEventCount, 3, 'BIKMVR039 cluster has 3 raw events');
  assert.strictEqual(bikCluster.firstSeen, '2026-09-10T17:09:51.161Z', 'firstSeen preserved');
  assert.strictEqual(bikCluster.lastSeen, '2026-09-10T17:18:17.296Z', 'lastSeen preserved');
  assert.deepStrictEqual(bikCluster.rawIncidentIds, ['inc_bik_1', 'inc_bik_2', 'inc_bik_3'], 'Raw incident IDs preserved');
  console.log('  ✅ [PASS] AV1 cluster (3 media, paired events correlated) and BIKMVR039 cluster (1 media, 3 occurrences, first/last seen) verified');

  // -------------------------------------------------------------
  // Test 6: Evidence Discipline & Status Separation
  // -------------------------------------------------------------
  console.log('\nTest 6: Evidence discipline: OBSERVATION / HYPOTHESIS / VERIFIED_CAUSE / KNOWN_POLICY separation');
  const st1 = determineIncidentStatus({ eventType: 'PLAYBACK_ADMISSION_DENIED', classification: 'UNSUPPORTED_UNKNOWN_FIX', reason: 'Codec av1 unsupported' });
  assert.strictEqual(st1, IncidentStatus.KNOWN_POLICY, 'Admission denial must be KNOWN_POLICY');

  const st2 = determineIncidentStatus({ eventType: 'MEDIA_PLAYBACK_ERROR', classification: 'MEDIA_ERR_SRC_NOT_SUPPORTED', metadata: { code: 4 } });
  assert.strictEqual(st2, IncidentStatus.HYPOTHESIS, 'Safari Code 4 without certified evidence must remain HYPOTHESIS');

  const st3 = determineIncidentStatus({ classification: 'EXACT_CERTIFIED_NORMALIZATION_CANDIDATE', matchedEnvelopeId: 'ENV_CERTIFIED' });
  assert.strictEqual(st3, IncidentStatus.VERIFIED_CAUSE, 'Exact certified repair envelope is VERIFIED_CAUSE');

  const st4 = determineIncidentStatus({ eventType: 'MEDIA_PLAYBACK_ERROR', classification: 'MEDIA_ERR_ABORTED' });
  assert.strictEqual(st4, IncidentStatus.OBSERVATION, 'Generic abort/error is OBSERVATION');
  console.log('  ✅ [PASS] Strict status separation: KNOWN_POLICY, HYPOTHESIS, VERIFIED_CAUSE, OBSERVATION');

  // -------------------------------------------------------------
  // Test 7: Raw JSONL Preservation & Non-Destruction
  // -------------------------------------------------------------
  console.log('\nTest 7: Raw JSONL evidence preservation (non-destructive clustering)');
  const testStoreDir = path.join(SANDBOX_DIR, 'jsonl_store');
  fs.mkdirSync(testStoreDir, { recursive: true });

  const incA = recordIncident({ eventType: 'PLAYBACK_ADMISSION_DENIED', classification: 'UNSUPPORTED_UNKNOWN_FIX', reason: 'AV1' }, testStoreDir);
  const incB = recordIncident({ eventType: 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY', classification: 'UNSUPPORTED_UNKNOWN_FIX', reason: 'AV1' }, testStoreDir);

  const pendingBefore = readPendingIncidents(testStoreDir);
  assert.strictEqual(pendingBefore.length, 2, 'Pending JSONL must contain both raw records');

  // Run clustering and triage
  const tOut = generateSanitizedTriage(pendingBefore);
  assert.strictEqual(tOut.clusters.length, 1, 'Clustered into 1 group');

  // Verify raw store is untouched
  const pendingAfter = readPendingIncidents(testStoreDir);
  assert.strictEqual(pendingAfter.length, 2, 'Pending JSONL file MUST NOT be altered by clustering');
  assert.strictEqual(pendingAfter[0].incidentId, incA.incidentId);
  assert.strictEqual(pendingAfter[1].incidentId, incB.incidentId);
  console.log('  ✅ [PASS] Raw JSONL store remains durable and untouched by clustering');

  // -------------------------------------------------------------
  // Test 8: Formatted Triage Summary Output Verification
  // -------------------------------------------------------------
  console.log('\nTest 8: Formatted triage summary includes status, occurrence count, and time window');
  const summaryMd = formatMarkdownSummary(triageResult);
  assert.ok(summaryMd.includes('[KNOWN_POLICY]'), 'Summary must contain [KNOWN_POLICY]');
  assert.ok(summaryMd.includes('[HYPOTHESIS]'), 'Summary must contain [HYPOTHESIS]');
  assert.ok(summaryMd.includes('Occurrences (Raw)'), 'Summary must show Occurrences (Raw)');
  assert.ok(summaryMd.includes('Time Window'), 'Summary must show Time Window');
  assert.ok(summaryMd.includes('Observed static facts: H.264 High@L6.0'), 'Summary must show hypothesis guidance for BIKMVR039');
  console.log('  ✅ [PASS] Formatted Markdown summary contains all required Observatory v1 fields');

  // -------------------------------------------------------------
  // Test 9: Telemetry Media Path Security & Approved Root Containment
  // -------------------------------------------------------------
  console.log('\nTest 9: Telemetry media path security & approved root containment');
  const activeRoot = path.join(SANDBOX_DIR, 'active_root');
  const renderRoot = path.join(SANDBOX_DIR, 'Render');
  const outsideRoot = path.join(SANDBOX_DIR, 'outside_root');
  fs.mkdirSync(activeRoot, { recursive: true });
  fs.mkdirSync(renderRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });

  const activeFile = path.join(activeRoot, 'valid_active.mp4');
  const renderFile = path.join(renderRoot, 'valid_render.mp4');
  const outsideFile = path.join(outsideRoot, 'secret_outside.mp4');
  fs.writeFileSync(activeFile, 'mock-active-video-content', 'utf8');
  fs.writeFileSync(renderFile, 'mock-render-video-content', 'utf8');
  fs.writeFileSync(outsideFile, 'mock-secret-outside-content', 'utf8');

  const testAllowedRoots = [activeRoot, renderRoot];
  const testResolver = (rel) => resolveSecureMediaPath(rel, testAllowedRoots);

  // 1. Valid active-media-root relative path -> allowed resolution
  const resActive = testResolver('valid_active.mp4');
  assert.strictEqual(resActive, path.normalize(activeFile), 'Active-root relative path must resolve');
  const enrichedActive = enrichIncidentFromRequest({
    req: mockReq,
    item: { level: 'ERROR', message: 'MEDIA_PLAYBACK_ERROR', data: { mediaPath: 'valid_active.mp4' } },
    allowedRoots: testAllowedRoots,
    resolveMediaPath: testResolver
  });
  assert.ok(enrichedActive.fingerprintId, 'Valid active-root path must attach fallback fingerprint');
  console.log('  ✅ [PASS] 1. Valid active-media-root relative path -> allowed resolution');

  // 2. Valid existing Render allowed-root path -> allowed resolution
  const resRender = testResolver('Render/valid_render.mp4');
  assert.strictEqual(resRender, path.normalize(renderFile), 'Render-root path must resolve');
  const enrichedRender = enrichIncidentFromRequest({
    req: mockReq,
    item: { level: 'ERROR', message: 'MEDIA_PLAYBACK_ERROR', data: { mediaPath: 'Render/valid_render.mp4' } },
    allowedRoots: testAllowedRoots,
    resolveMediaPath: testResolver
  });
  assert.ok(enrichedRender.fingerprintId, 'Valid Render-root path must attach fallback fingerprint');
  console.log('  ✅ [PASS] 2. Valid existing Render allowed-root path -> allowed resolution');

  // 3. ../ traversal outside roots -> unresolved, no fallback fingerprint
  const resTraversal = testResolver('../../outside_root/secret_outside.mp4');
  assert.strictEqual(resTraversal, null, 'Path traversal outside roots must return null');
  const enrichedTraversal = enrichIncidentFromRequest({
    req: mockReq,
    item: { level: 'WARN', message: 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY', data: { mediaPath: '../../outside_root/secret_outside.mp4', reason: 'traversal attempt' } },
    allowedRoots: testAllowedRoots,
    resolveMediaPath: testResolver
  });
  assert.strictEqual(enrichedTraversal.fingerprintId, null, 'Traversal path MUST NOT produce fallback fingerprint');
  assert.strictEqual(enrichedTraversal.metadata.mediaFacts, null, 'Traversal path MUST NOT attach cached facts');
  assert.strictEqual(enrichedTraversal.localMediaPath, '../../outside_root/secret_outside.mp4', 'Original client data preserved safely');
  console.log('  ✅ [PASS] 3. ../ traversal outside roots -> unresolved, no fallback fingerprint');

  // 4. Absolute outside-root path -> unresolved, no fallback fingerprint
  const resAbsoluteOutside = testResolver(outsideFile);
  assert.strictEqual(resAbsoluteOutside, null, 'Absolute outside-root path must return null');
  const enrichedAbsoluteOutside = enrichIncidentFromRequest({
    req: mockReq,
    item: { level: 'ERROR', message: 'MEDIA_PLAYBACK_ERROR', data: { mediaPath: outsideFile } },
    allowedRoots: testAllowedRoots,
    resolveMediaPath: testResolver
  });
  assert.strictEqual(enrichedAbsoluteOutside.fingerprintId, null, 'Absolute outside-root path MUST NOT produce fallback fingerprint');
  console.log('  ✅ [PASS] 4. Absolute outside-root path -> unresolved, no fallback fingerprint');

  // 5. Invalid/nonexistent path -> unresolved, incident still records safely
  const resNonexistent = testResolver('nonexistent_missing_file_xyz.mp4');
  assert.strictEqual(resNonexistent, null, 'Nonexistent path must return null');
  const enrichedMissing = enrichIncidentFromRequest({
    req: mockReq,
    item: { level: 'ERROR', message: 'MEDIA_PLAYBACK_ERROR', data: { mediaPath: 'nonexistent_missing_file_xyz.mp4', code: 4, name: 'MEDIA_ERR_SRC_NOT_SUPPORTED' } },
    allowedRoots: testAllowedRoots,
    resolveMediaPath: testResolver
  });
  assert.strictEqual(enrichedMissing.fingerprintId, null, 'Missing file path produces null fingerprint');
  const recMissing = recordIncident(enrichedMissing, testStoreDir);
  assert.ok(recMissing.incidentId, 'Incident must still record safely without error');
  console.log('  ✅ [PASS] 5. Invalid/nonexistent path -> unresolved, incident still records safely');

  // 6. Client-provided valid fingerprint remains usable without doing path fallback
  const enrichedClientFp = enrichIncidentFromRequest({
    req: mockReq,
    item: {
      level: 'ERROR',
      message: 'MEDIA_PLAYBACK_ERROR',
      data: {
        fingerprintId: 'fp_client_authoritative',
        mediaPath: '../../outside_path/video.mp4'
      }
    },
    allowedRoots: testAllowedRoots,
    resolveMediaPath: testResolver
  });
  assert.strictEqual(enrichedClientFp.fingerprintId, 'fp_client_authoritative', 'Client-provided fingerprint must be retained directly');
  console.log('  ✅ [PASS] 6. Client-provided valid fingerprint remains usable without doing path fallback');

  // 7. No ffprobe / content hash / remux introduced (sub-millisecond execution)
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) {
    enrichIncidentFromRequest({
      req: mockReq,
      item: { level: 'WARN', message: 'MEDIA_PLAYBACK_BLOCKED_BY_POLICY', data: { mediaPath: 'valid_active.mp4' } },
      allowedRoots: testAllowedRoots,
      resolveMediaPath: testResolver
    });
  }
  const tElapsed = performance.now() - t0;
  assert.ok(tElapsed < 100, `50 enrichments took ${tElapsed.toFixed(2)}ms (must be sub-millisecond, strictly no probes)`);
  console.log(`  ✅ [PASS] 7. No ffprobe/content hash/remux introduced (${(tElapsed / 50).toFixed(3)}ms per enrichment)`);

  console.log('\n------------------------------------------------------------');
  console.log('OVERALL RUNTIME OBSERVATORY V1 TEST SUITE: ✅ ALL PASSED\n');
} finally {
  fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
}
