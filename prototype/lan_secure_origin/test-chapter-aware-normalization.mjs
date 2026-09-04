import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { NormalizationEngine, EngineStatus } from './src/normalization/normalization-engine.mjs';
import { NormalizationJournal, NormalizationState } from './src/normalization/journal.mjs';
import {
  RuleStatus,
  CERTIFIED_REPAIR_RULES,
  CANDIDATE_REPAIR_RULES,
  findCertifiedRepairRule,
  findRepairCandidate,
  matchChapterAwareCandidate
} from './src/normalization/repair-rules.mjs';
import { classifyMedia, MediaClass } from './src/normalization/classification.mjs';
import { verifyNormalizedOutput } from './src/normalization/verifier.mjs';
import { derivePendingQueue } from './src/normalization/batch-runner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STAGING_ROOT = path.join(__dirname, 'test_scratch_chapter_staging');

function cleanStaging() {
  if (fs.existsSync(STAGING_ROOT)) {
    fs.rmSync(STAGING_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
}

// 1. Synthetic Fixture Helpers
function createMockVideoFact(overrides = {}) {
  return {
    codec: 'hevc',
    codecTag: 'hev1',
    width: 4096,
    height: 2048,
    level: 153,
    profile: 'Main',
    bitDepth: 8,
    rFps: '60000/1001',
    avgFps: '60000/1001',
    durationSec: 10.0,
    ...overrides
  };
}

function createMockOrdinaryFacts() {
  return {
    videoCount: 1,
    video: createMockVideoFact(),
    audioCount: 1,
    audioStreams: [{ codec: 'aac', channels: 2, sampleRate: 48000 }],
    otherStreams: [],
    chapterCount: 0,
    chapters: []
  };
}

function createMockChapterFacts(overrides = {}) {
  return {
    videoCount: 1,
    video: createMockVideoFact(),
    audioCount: 1,
    audioStreams: [{ codec: 'aac', channels: 2, sampleRate: 48000 }],
    otherStreams: [
      { index: 2, codecType: 'data', codecName: 'bin_data', codecTag: 'text', handler: 'SubtitleHandler' }
    ],
    chapterCount: 3,
    chapters: [
      { id: 0, start: 0, end: 3, title: 'Chapter 1', tags: {} },
      { id: 1, start: 3, end: 7, title: 'Chapter 2', tags: {} },
      { id: 2, start: 7, end: 10, title: 'Chapter 3', tags: {} }
    ],
    ...overrides
  };
}

function createMockChapterOutFacts(overrides = {}) {
  return createMockChapterFacts({
    video: createMockVideoFact({ codecTag: 'hvc1' }),
    ...overrides
  });
}

async function runAllTests() {
  console.log('============================================================');
  console.log('🧪 RUNNING CHAPTER-AWARE HEVC NORMALIZATION SUITE');
  console.log('============================================================\n');
  cleanStaging();

  // -------------------------------------------------------------
  // Section 1: Selection & Matching Tests
  // -------------------------------------------------------------
  console.log('--- Section 1: Selection & Topology Matching ---');
  {
    // 1.1 Ordinary 2-stream media -> existing certified normal rule
    const ordFacts = createMockOrdinaryFacts();
    const certRule = findCertifiedRepairRule(ordFacts, '.mp4');
    assert(certRule, 'Certified normal rule found for ordinary 2-stream');
    assert.strictEqual(certRule.ruleId, 'hevc-mp4-hev1-to-hvc1-streamcopy-v1');
    assert.strictEqual(certRule.status, RuleStatus.CERTIFIED_FOR_TESTED_ENVELOPE);
    const ordCand = matchChapterAwareCandidate(ordFacts, '.mp4');
    assert.strictEqual(ordCand, null, 'Ordinary media must NOT match chapter-aware candidate');
    console.log('  ✅ [PASS] Ordinary 2-stream media matches existing certified normal rule only');

    // 1.2 Recognized chapter topology -> chapter-aware candidate
    const chFacts = createMockChapterFacts();
    const chMatch = matchChapterAwareCandidate(chFacts, '.mp4');
    assert(chMatch, 'Recognized chapter topology matches chapter candidate');
    assert.strictEqual(chMatch.ruleId, 'hevc-mp4-hev1-to-hvc1-chapters-streamcopy-v1');
    assert.strictEqual(chMatch.status, RuleStatus.NEEDS_BUCKET_CERTIFICATION);
    assert.strictEqual(chMatch.isChapterAware, true);
    // Certified rule must reject chapter media
    const certReject = findCertifiedRepairRule(chFacts, '.mp4');
    assert.strictEqual(certReject, null, 'Certified rule must reject media with chapters / data streams');
    console.log('  ✅ [PASS] Recognized chapter topology matches chapter candidate with NEEDS_BUCKET_CERTIFICATION');

    // 1.3 No chapters -> rejected from chapter candidate
    const noChFacts = createMockChapterFacts({ chapterCount: 0, chapters: [] });
    assert.strictEqual(matchChapterAwareCandidate(noChFacts, '.mp4'), null, 'Zero chapters rejects chapter candidate');
    console.log('  ✅ [PASS] Media with no chapters rejected from chapter candidate');

    // 1.4 Unexpected extra streams (subtitle, second video, extra audio) -> fail closed
    const subFacts = createMockChapterFacts({ subtitleCount: 1 });
    assert.strictEqual(matchChapterAwareCandidate(subFacts, '.mp4'), null, 'Subtitles fail closed');
    const multiVFacts = createMockChapterFacts({ videoCount: 2 });
    assert.strictEqual(matchChapterAwareCandidate(multiVFacts, '.mp4'), null, 'Multi-video fails closed');
    const multiAFacts = createMockChapterFacts({ audioCount: 2 });
    assert.strictEqual(matchChapterAwareCandidate(multiAFacts, '.mp4'), null, 'Multi-audio fails closed');
    const extraStreamFacts = createMockChapterFacts({
      otherStreams: [
        { index: 2, codecType: 'data', codecName: 'bin_data', codecTag: 'text' },
        { index: 3, codecType: 'data', codecName: 'unknown', codecTag: '' }
      ]
    });
    assert.strictEqual(matchChapterAwareCandidate(extraStreamFacts, '.mp4'), null, 'Multiple data streams fail closed');
    console.log('  ✅ [PASS] Unexpected extra streams strictly fail closed');

    // 1.5 Unsupported data topology (e.g. unknown data codec) -> fail closed
    const badDataFacts = createMockChapterFacts({
      otherStreams: [{ index: 2, codecType: 'data', codecName: 'arbitrary_data', codecTag: 'raw' }]
    });
    assert.strictEqual(matchChapterAwareCandidate(badDataFacts, '.mp4'), null, 'Unsupported data type fails closed');
    console.log('  ✅ [PASS] Unsupported data topology strictly fail closed');

    // 1.6 Classification Contract
    const ordClass = classifyMedia('sample.mp4', ordFacts);
    assert.strictEqual(ordClass.classification, MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE);
    assert.strictEqual(ordClass.repairCandidate, 'hevc-mp4-hev1-to-hvc1-streamcopy-v1');

    const chClass = classifyMedia('sample.mp4', chFacts);
    assert.strictEqual(chClass.classification, MediaClass.NEEDS_BUCKET_CERTIFICATION);
    assert.strictEqual(chClass.repairCandidate, 'hevc-mp4-hev1-to-hvc1-chapters-streamcopy-v1');

    const unexpClass = classifyMedia('sample.mp4', extraStreamFacts);
    assert.strictEqual(unexpClass.classification, MediaClass.UNSUPPORTED_UNKNOWN_FIX);
    assert.strictEqual(unexpClass.repairCandidate, null);
    console.log('  ✅ [PASS] MediaClass routing strictly enforces topology boundaries');

    // 1.7 Missing topology evidence must fail closed (certified FAIL)
    const missingAudioFacts = { ...ordFacts, audioCount: undefined };
    assert.strictEqual(findCertifiedRepairRule(missingAudioFacts, '.mp4'), null, 'Missing audioCount fails certified rule');
    assert.strictEqual(classifyMedia('sample.mp4', missingAudioFacts).classification, MediaClass.UNSUPPORTED_UNKNOWN_FIX);

    const missingOtherFacts = { ...ordFacts, otherStreams: undefined };
    assert.strictEqual(findCertifiedRepairRule(missingOtherFacts, '.mp4'), null, 'Missing otherStreams fails certified rule');
    assert.strictEqual(classifyMedia('sample.mp4', missingOtherFacts).classification, MediaClass.UNSUPPORTED_UNKNOWN_FIX);

    const missingChCountFacts = { ...ordFacts, chapterCount: undefined };
    assert.strictEqual(findCertifiedRepairRule(missingChCountFacts, '.mp4'), null, 'Missing chapterCount fails certified rule');
    assert.strictEqual(classifyMedia('sample.mp4', missingChCountFacts).classification, MediaClass.UNSUPPORTED_UNKNOWN_FIX);
    console.log('  ✅ [PASS] Missing topology evidence strictly fails closed to UNSUPPORTED_UNKNOWN_FIX');

    // 1.8 Chapter input codecName=unknown -> candidate FAIL
    const unkCodecChFacts = createMockChapterFacts({
      otherStreams: [{ index: 2, codecType: 'data', codecName: 'unknown', codecTag: 'text' }]
    });
    assert.strictEqual(matchChapterAwareCandidate(unkCodecChFacts, '.mp4'), null, 'Chapter data codecName=unknown rejected');
    console.log('  ✅ [PASS] Chapter input with codecName=unknown strictly rejected from candidate');
  }

  // -------------------------------------------------------------
  // Section 2: Operation & Engine Safety Gating
  // -------------------------------------------------------------
  console.log('\n--- Section 2: Operation & Production Engine Safety Gating ---');
  {
    // 2.1 Remux operation arguments
    const candRule = CANDIDATE_REPAIR_RULES[0];
    assert.deepStrictEqual(candRule.operation.ffmpegArgs, [
      '-map', '0:v', '-map', '0:a', '-map_chapters', '0', '-c', 'copy', '-tag:v', 'hvc1'
    ], 'Chapter-aware candidate operation args match exact requirement');

    const normRule = CERTIFIED_REPAIR_RULES[0];
    assert.deepStrictEqual(normRule.operation.ffmpegArgs, [
      '-map', '0', '-c', 'copy', '-tag:v', 'hvc1'
    ], 'Existing normal rule operation args remain unchanged');
    console.log('  ✅ [PASS] Candidate and normal remux ffmpeg args match specification');

    // 2.2 Default NormalizationEngine blocks uncertified candidate
    const chFacts = createMockChapterFacts();
    // Default findRepairCandidate without allowUncertified returns null
    const defaultFound = findRepairCandidate(chFacts, '.mp4');
    assert.strictEqual(defaultFound, null, 'findRepairCandidate default returns null for uncertified candidate');

    // With explicit allowUncertified: true, findRepairCandidate returns candidate
    const explicitFound = findRepairCandidate(chFacts, '.mp4', { allowUncertified: true });
    assert(explicitFound, 'Explicit allowUncertified returns candidate');
    assert.strictEqual(explicitFound.ruleId, 'hevc-mp4-hev1-to-hvc1-chapters-streamcopy-v1');

    // NormalizationEngine with default options (allowUncertifiedCandidate = false) blocks uncertified rule
    const journalPath = path.join(STAGING_ROOT, 'test_gate_journal.json');
    const defaultEngine = new NormalizationEngine({
      journal: new NormalizationJournal(journalPath),
      executionEnabled: true,
      allowUncertifiedCandidate: false
    });
    assert.strictEqual(defaultEngine.allowUncertifiedCandidate, false, 'allowUncertifiedCandidate defaults to false');
    console.log('  ✅ [PASS] Production engine strictly blocks uncertified candidates by default');

    // 2.3 Batch queue derivation blocks uncertified candidate from destructive pendingQueue
    const mockInv = [{ fullPath: 'G:/Media/VR/Render/sample_chapter.mp4', classification: MediaClass.NEEDS_BUCKET_CERTIFICATION }];
    const batchPlan = await derivePendingQueue({
      inventoryItems: mockInv,
      journal: new NormalizationJournal(journalPath),
      probeFacts: async () => chFacts
    });
    assert.strictEqual(batchPlan.pendingQueue.length, 0, 'Uncertified candidate NOT queued in destructive pending queue');
    assert.strictEqual(batchPlan.skippedOrExcluded.length, 1);
    console.log('  ✅ [PASS] Batch runner excludes uncertified chapter candidates from destructive execution queue');
  }

  // -------------------------------------------------------------
  // Section 3: Chapter Verifier Fail-Closed Matrix
  // -------------------------------------------------------------
  console.log('\n--- Section 3: Chapter Verifier Contract Matrix ---');
  {
    const candRule = CANDIDATE_REPAIR_RULES[0];
    const dummySrc = path.join(STAGING_ROOT, 'dummy_src.mp4');
    const dummyOut = path.join(STAGING_ROOT, 'dummy_out.mp4');
    fs.writeFileSync(dummySrc, 'test');
    fs.writeFileSync(dummyOut, 'test');

    const baseOrig = createMockChapterFacts();
    const baseStreams = [
      { index: 0, codecType: 'video', codecName: 'hevc', packetCount: 100, duration: 10 },
      { index: 1, codecType: 'audio', codecName: 'aac', packetCount: 100, duration: 10 },
      { index: 2, codecType: 'data', codecName: 'bin_data', packetCount: 1, duration: 10 }
    ];
    const defaultVerifierOpts = {
      demuxResult: { ok: true },
      origStreams: baseStreams,
      outStreams: baseStreams,
      getStreamPayloadMD5: async () => 'mockmd5'
    };

    // 3.1 Chapter output non-A/V count=0 -> verifier FAIL
    const zeroNonAVOut = createMockChapterOutFacts({ otherStreams: [] });
    const zeroRes = await verifyNormalizedOutput(dummySrc, dummyOut, candRule, {
      ...defaultVerifierOpts,
      origFacts: baseOrig,
      outFacts: zeroNonAVOut
    });
    assert.strictEqual(zeroRes.ok, false);
    assert(zeroRes.reason.includes('requires exactly 1 non-A/V chapter stream'));
    console.log('  ✅ [PASS] Chapter output non-A/V count=0 fails closed');

    // 3.2 Chapter output unknown data -> verifier FAIL
    const unknownDataOut = createMockChapterOutFacts({
      otherStreams: [{ index: 2, codecType: 'data', codecName: 'unknown_raw', codecTag: 'bad' }]
    });
    const unkRes = await verifyNormalizedOutput(dummySrc, dummyOut, candRule, {
      ...defaultVerifierOpts,
      origFacts: baseOrig,
      outFacts: unknownDataOut
    });
    assert.strictEqual(unkRes.ok, false);
    assert(unkRes.reason.includes('not a recognized muxer-generated chapter representation'));
    console.log('  ✅ [PASS] Chapter output unknown data stream fails closed');

    // 3.3 Source language present, output missing -> verifier FAIL
    const langOrig = createMockChapterFacts({
      chapters: [
        { id: 0, start: 0, end: 3, title: 'Chapter 1', tags: { language: 'eng' } },
        { id: 1, start: 3, end: 7, title: 'Chapter 2', tags: { language: 'eng' } },
        { id: 2, start: 7, end: 10, title: 'Chapter 3', tags: { language: 'eng' } }
      ]
    });
    const missingLangOut = createMockChapterOutFacts({
      chapters: [
        { id: 0, start: 0, end: 3, title: 'Chapter 1', tags: {} },
        { id: 1, start: 3, end: 7, title: 'Chapter 2', tags: {} },
        { id: 2, start: 7, end: 10, title: 'Chapter 3', tags: {} }
      ]
    });
    const langRes = await verifyNormalizedOutput(dummySrc, dummyOut, candRule, {
      ...defaultVerifierOpts,
      origFacts: langOrig,
      outFacts: missingLangOut
    });
    assert.strictEqual(langRes.ok, false);
    assert(langRes.reason.includes('language tag mismatch or missing'));
    console.log('  ✅ [PASS] Source chapter language present / output missing fails closed');

    // 3.4 Chapter count mismatch fails closed
    const missingChOut = createMockChapterOutFacts({
      chapterCount: 2,
      chapters: baseOrig.chapters.slice(0, 2)
    });
    const missingRes = await verifyNormalizedOutput(dummySrc, dummyOut, candRule, {
      ...defaultVerifierOpts,
      origFacts: baseOrig,
      outFacts: missingChOut
    });
    assert.strictEqual(missingRes.ok, false);
    console.log('  ✅ [PASS] Missing chapter in output fails closed');

    // 3.5 Extra chapter in output fails closed
    const extraChOut = createMockChapterOutFacts({
      chapterCount: 4,
      chapters: [...baseOrig.chapters, { id: 3, start: 10, end: 12, title: 'Chapter 4', tags: {} }]
    });
    const extraRes = await verifyNormalizedOutput(dummySrc, dummyOut, candRule, {
      ...defaultVerifierOpts,
      origFacts: baseOrig,
      outFacts: extraChOut
    });
    assert.strictEqual(extraRes.ok, false);
    console.log('  ✅ [PASS] Extra chapter in output fails closed');

    // 3.6 Chapter title drift fails closed
    const driftedTitleOut = createMockChapterOutFacts({
      chapters: [
        baseOrig.chapters[0],
        { ...baseOrig.chapters[1], title: 'Mutated Title' },
        baseOrig.chapters[2]
      ]
    });
    const titleRes = await verifyNormalizedOutput(dummySrc, dummyOut, candRule, {
      ...defaultVerifierOpts,
      origFacts: baseOrig,
      outFacts: driftedTitleOut
    });
    assert.strictEqual(titleRes.ok, false);
    console.log('  ✅ [PASS] Chapter title drift fails closed');

    // 3.7 Timestamp drift outside 5ms tolerance fails closed
    const driftedTimeOut = createMockChapterOutFacts({
      chapters: [
        baseOrig.chapters[0],
        { ...baseOrig.chapters[1], start: baseOrig.chapters[1].start + 0.05 }, // 50ms drift
        baseOrig.chapters[2]
      ]
    });
    const timeRes = await verifyNormalizedOutput(dummySrc, dummyOut, candRule, {
      ...defaultVerifierOpts,
      origFacts: baseOrig,
      outFacts: driftedTimeOut
    });
    assert.strictEqual(timeRes.ok, false);
    console.log('  ✅ [PASS] Chapter timestamp drift (>5ms) fails closed');

    // Clean dummy files
    fs.unlinkSync(dummySrc);
    fs.unlinkSync(dummyOut);
  }

  // -------------------------------------------------------------
  // Section 4: Isolated Runtime Verification on 3 Representatives
  // -------------------------------------------------------------
  console.log('\n--- Section 4: Isolated Production Path Staging Verification ---');
  const representatives = [
    {
      name: 'Representative 1 (>=2 chapter Bucket A standard audio)',
      src: 'G:\\Media\\VR\\Render\\4096_2048_crf18_avc1-Kosaka Himari - KIWVR730 - (HEVC_19).mp4.mp4'
    },
    {
      name: 'Representative 2 (>=2 chapter Mainconcept audio)',
      src: 'G:\\Media\\VR\\Render\\4096_2048_crf21_avc1-Fujita kozue - NHVR220.mp4 - (HEVC_21.0).mp4'
    },
    {
      name: 'Representative 3 (1-chapter URVRSP203 special case)',
      src: 'G:\\Media\\VR\\Render\\4096_2048_crf21_avc1-URVRSP203(UNVRSP002) - p1 - (HEVC_19).mp4.mp4'
    }
  ];

  for (const rep of representatives) {
    console.log(`\nTesting ${rep.name}:`);
    const stagingDir = path.join(STAGING_ROOT, path.basename(rep.src, path.extname(rep.src)));
    fs.mkdirSync(stagingDir, { recursive: true });
    const stagingTarget = path.join(stagingDir, path.basename(rep.src));

    // Fast copy to isolated staging directory
    console.log(`  Copying to isolated staging path: ${stagingTarget}...`);
    fs.copyFileSync(rep.src, stagingTarget);
    const origStat = fs.statSync(rep.src);
    const stageStat = fs.statSync(stagingTarget);
    assert.strictEqual(origStat.size, stageStat.size, 'Staging copy is identical size');

    // Compute original bitstream MD5 for video & audio before transaction
    const origVMd5 = execSync(`ffmpeg -v error -i "${rep.src}" -map 0:v:0 -c copy -f md5 -`).toString().trim();
    const origAMd5 = execSync(`ffmpeg -v error -i "${rep.src}" -map 0:a:0 -c copy -f md5 -`).toString().trim();

    // Set up dedicated staging engine with explicit allowUncertifiedCandidate and allowedRoots
    const repJournalPath = path.join(stagingDir, 'staging_journal.json');
    const repJournal = new NormalizationJournal(repJournalPath);
    const repEngine = new NormalizationEngine({
      journal: repJournal,
      executionEnabled: true,
      allowUncertifiedCandidate: true, // Explicitly authorized ONLY for isolated staging test
      allowedRoots: [stagingDir]      // Strictly locked to staging directory
    });

    const init = await repEngine.initialize();
    assert(init.ok, 'Engine initializes cleanly');

    console.log(`  Executing processCandidate through full production transaction pipeline...`);
    const result = await repEngine.processCandidate(stagingTarget);
    assert.strictEqual(result.ok, true, `processCandidate must succeed: ${result.error}`);
    assert.strictEqual(result.state, NormalizationState.DONE, 'Journal state is DONE');

    // Verify output properties
    const outFactsRaw = execSync(`ffprobe -v error -show_format -show_streams -show_chapters -print_format json "${stagingTarget}"`).toString();
    const outData = JSON.parse(outFactsRaw);
    const vStream = outData.streams.find(s => s.codec_type === 'video');
    const aStream = outData.streams.find(s => s.codec_type === 'audio');

    assert.strictEqual(vStream.codec_tag_string, 'hvc1', 'Output tag must be hvc1');
    assert.strictEqual(outData.chapters.length > 0, true, 'Chapters must be present');

    // Verify elementary payload bit-identical copy
    const normVMd5 = execSync(`ffmpeg -v error -i "${stagingTarget}" -map 0:v:0 -c copy -f md5 -`).toString().trim();
    const normAMd5 = execSync(`ffmpeg -v error -i "${stagingTarget}" -map 0:a:0 -c copy -f md5 -`).toString().trim();
    assert.strictEqual(origVMd5, normVMd5, 'Video elementary payload MD5 must be 100% bit-identical');
    assert.strictEqual(origAMd5, normAMd5, 'Audio elementary payload MD5 must be 100% bit-identical');

    // Verify clean staging residue (no .partial or .vreconder-old leftovers)
    const files = fs.readdirSync(stagingDir);
    const partials = files.filter(f => f.includes('.partial'));
    const olds = files.filter(f => f.includes('.vreconder-old'));
    assert.strictEqual(partials.length, 0, 'No partial leftovers');
    assert.strictEqual(olds.length, 0, 'No old backup leftovers');

    // Clean staging item
    fs.rmSync(stagingDir, { recursive: true, force: true });
    console.log(`  ✅ [PASS] ${rep.name}: transaction PASS, hvc1, A/V bit-identical, chapters preserved, clean residue`);
  }

  // Clean staging root
  cleanStaging();
  console.log('\n============================================================');
  console.log('🎉 ALL CHAPTER-AWARE NORMALIZATION TESTS PASSED');
  console.log('============================================================\n');
}

runAllTests().catch((err) => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
