import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { probeMediaFacts } from './ffprobe-facts.mjs';

/**
 * Runs fast lossless container and packet-level demux integrity check using stream-copy.
 * Verifies 100% of container packets and atom structures without decoding video frames into pixels.
 * 
 * @param {string} filePath 
 * @param {object} options
 * @returns {Promise<{ ok: boolean, error: string | null }>}
 */
export async function runStreamcopyDemuxIntegrityCheck(filePath, options = {}) {
  return new Promise((resolve) => {
    if (options.isCancelled?.()) {
      return resolve({ ok: false, error: 'CANCELLED_BEFORE_DEMUX_CHECK' });
    }
    const args = [
      '-v', 'error',
      '-xerror',
      '-i', filePath,
      '-c', 'copy',
      '-f', 'null',
      '-'
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    options.onChildProcess?.(child);
    let stderr = '';

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => {
      if (code === 0 && !stderr.trim()) {
        resolve({ ok: true, error: null });
      } else {
        resolve({ ok: false, error: stderr.trim() || `ffmpeg demux check exited with code ${code}` });
      }
    });
  });
}

/**
 * Counts stream packets and duration using ffprobe for each individual stream.
 * 
 * @param {string} filePath 
 * @param {object} options
 * @returns {Promise<Array<{ index: number, codecType: string, codecName: string, packetCount: number, duration: number }> | null>}
 */
export async function getPerStreamPacketDetails(filePath, options = {}) {
  return new Promise((resolve) => {
    if (options.isCancelled?.()) return resolve(null);
    const args = [
      '-v', 'error',
      '-count_packets',
      '-show_entries', 'stream=index,codec_type,codec_name,nb_read_packets,nb_packets,duration',
      '-print_format', 'json',
      filePath
    ];

    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    options.onChildProcess?.(child);
    let stdout = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) return resolve(null);
      try {
        const raw = JSON.parse(stdout);
        const streams = (raw.streams || []).map(s => {
          const countStr = s.nb_read_packets || s.nb_packets;
          const count = countStr ? parseInt(countStr, 10) : 0;
          return {
            index: s.index,
            codecType: s.codec_type,
            codecName: s.codec_name,
            packetCount: isNaN(count) ? 0 : count,
            duration: parseFloat(s.duration || '0')
          };
        });
        resolve(streams);
      } catch (e) {
        resolve(null);
      }
    });
  });
}

/**
 * Computes exact MD5 hash of an elementary stream bitstream payload via ffmpeg stream copy.
 * 
 * @param {string} filePath 
 * @param {string} streamSpecifier - e.g. '0:v:0', '0:a:0'
 * @param {object} options
 * @returns {Promise<string | null>}
 */
export async function getStreamPayloadMD5(filePath, streamSpecifier, options = {}) {
  return new Promise((resolve) => {
    if (options.isCancelled?.()) return resolve(null);
    const args = [
      '-v', 'error',
      '-i', filePath,
      '-map', streamSpecifier,
      '-c', 'copy',
      '-f', 'md5',
      '-'
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    options.onChildProcess?.(child);
    let stdout = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) return resolve(null);
      const match = stdout.trim().match(/MD5=([0-9a-fA-F]+)/);
      if (match) {
        resolve(match[1].toLowerCase());
      } else {
        resolve(stdout.trim().replace(/^MD5=/, '').toLowerCase());
      }
    });
  });
}

/**
 * Full Pipeline Verification:
 * Validates structural invariants across all retained streams, container demux integrity,
 * per-stream packet counts, and elementary stream payload hash equivalence.
 * Fail-Closed: returns ok: false if any required evidence cannot be acquired.
 * 
 * @param {string} originalPath 
 * @param {string} outputPath 
 * @param {object} expectedRule 
 * @param {object} options - { onChildProcess, isCancelled }
 * @returns {Promise<{ ok: boolean, reason: string | null, details: object }>}
 */
export async function verifyNormalizedOutput(originalPath, outputPath, expectedRule = {}, options = {}) {
  if (options.isCancelled?.()) {
    return { ok: false, reason: 'Verification cancelled', details: {} };
  }

  const origFacts = options.origFacts || options.mockOrigFacts || await probeMediaFacts(originalPath, options);
  if (!origFacts || !origFacts.video) {
    return { ok: false, reason: 'Original media cannot be probed', details: {} };
  }

  if (options.isCancelled?.()) {
    return { ok: false, reason: 'Verification cancelled', details: {} };
  }

  const outFacts = options.outFacts || options.mockOutFacts || await probeMediaFacts(outputPath, options);
  if (!outFacts || !outFacts.video) {
    return { ok: false, reason: 'Output media cannot be probed by ffprobe', details: {} };
  }

  // 1. Video Invariants (Check ALL video streams)
  const origVideoCount = origFacts.videoCount || 1;
  const outVideoCount = outFacts.videoCount || 1;
  if (origVideoCount !== outVideoCount) {
    return { ok: false, reason: `Video stream count mismatch: ${origVideoCount} vs ${outVideoCount}`, details: {} };
  }

  for (let vIdx = 0; vIdx < origVideoCount; vIdx++) {
    const oV = (origFacts.videoStreams && origFacts.videoStreams[vIdx]) || origFacts.video;
    const nV = (outFacts.videoStreams && outFacts.videoStreams[vIdx]) || outFacts.video;

    if (!nV) {
      return { ok: false, reason: `Output video stream [${vIdx}] is missing`, details: { oV, nV } };
    }
    if (oV.codec !== nV.codec) {
      return { ok: false, reason: `Video [${vIdx}] codec mismatch: ${oV.codec} vs ${nV.codec}`, details: { oV, nV } };
    }
    if (oV.width !== nV.width || oV.height !== nV.height) {
      return { ok: false, reason: `Video [${vIdx}] dimensions mismatch: ${oV.width}x${oV.height} vs ${nV.width}x${nV.height}`, details: { oV, nV } };
    }
    if (oV.profile !== nV.profile) {
      return { ok: false, reason: `Video [${vIdx}] profile mismatch: ${oV.profile} vs ${nV.profile}`, details: { oV, nV } };
    }
    if (oV.level !== nV.level) {
      return { ok: false, reason: `Video [${vIdx}] level mismatch: ${oV.level} vs ${nV.level}`, details: { oV, nV } };
    }
    if (oV.pixFmt !== nV.pixFmt || oV.bitDepth !== nV.bitDepth) {
      return { ok: false, reason: `Video [${vIdx}] pixel format / bit depth mismatch: ${oV.pixFmt}/${oV.bitDepth} vs ${nV.pixFmt}/${nV.bitDepth}`, details: { oV, nV } };
    }
    if (oV.rFps !== nV.rFps || oV.avgFps !== nV.avgFps) {
      return { ok: false, reason: `Video [${vIdx}] frame rate mismatch: rFps ${oV.rFps}/avgFps ${oV.avgFps} vs rFps ${nV.rFps}/avgFps ${nV.avgFps}`, details: { oV, nV } };
    }
    if (Math.abs(oV.durationSec - nV.durationSec) > 0.5) {
      return { ok: false, reason: `Video [${vIdx}] duration divergence: ${oV.durationSec}s vs ${nV.durationSec}s`, details: { oV, nV } };
    }
  }

  // 2. Audio Invariants (Check all audio streams)
  if (origFacts.audioCount !== outFacts.audioCount) {
    return { ok: false, reason: `Audio stream count mismatch: ${origFacts.audioCount} vs ${outFacts.audioCount}`, details: {} };
  }
  for (let i = 0; i < origFacts.audioCount; i++) {
    const origA = origFacts.audioStreams[i];
    const outA = outFacts.audioStreams[i];
    if (!outA || origA.codec !== outA.codec || origA.channels !== outA.channels || origA.sampleRate !== outA.sampleRate) {
      return { ok: false, reason: `Audio stream [${i}] properties mismatch`, details: { origA, outA } };
    }
  }

  // 3. Expected Target Tag Validation (hev1 -> hvc1 is the explicitly authorized mutation)
  const expectedTag = expectedRule.expectedOutputTag || 'hvc1';
  const primaryOutVideo = (outFacts.videoStreams && outFacts.videoStreams[0]) || outFacts.video;
  if ((primaryOutVideo.codecTag || '').toLowerCase() !== expectedTag.toLowerCase()) {
    return { ok: false, reason: `Target tag requirement not met: expected ${expectedTag}, got ${primaryOutVideo.codecTag}`, details: { primaryOutVideo } };
  }

  if (options.isCancelled?.()) {
    return { ok: false, reason: 'Verification cancelled', details: {} };
  }

  // 4. Container & Packet Demux Validation (checks all container streams & packets)
  const demuxResult = options.demuxResult || await runStreamcopyDemuxIntegrityCheck(outputPath, options);
  if (!demuxResult.ok) {
    return { ok: false, reason: `Container stream demux check failed: ${demuxResult.error}`, details: demuxResult };
  }

  if (options.isCancelled?.()) {
    return { ok: false, reason: 'Verification cancelled', details: {} };
  }

  // 5. Per-Stream Packet Count Equality (P0-5 Fail-Closed: null or 0 packets fails verification)
  const origStreams = options.origStreams || await getPerStreamPacketDetails(originalPath, options);
  const outStreams = options.outStreams || await getPerStreamPacketDetails(outputPath, options);
  if (!origStreams || !outStreams) {
    return { ok: false, reason: 'Failed to retrieve per-stream packet details (ffprobe unavailable or unparseable)', details: {} };
  }
  if (expectedRule.isChapterAware) {
    // 1. Check video packet counts
    const origVStreams = origStreams.filter(s => s.codecType === 'video');
    const outVStreams = outStreams.filter(s => s.codecType === 'video');
    if (origVStreams.length !== outVStreams.length || origVStreams.length !== origVideoCount) {
      return { ok: false, reason: `Video stream count mismatch in packet probe: ${origVStreams.length} vs ${outVStreams.length}`, details: {} };
    }
    for (let i = 0; i < origVStreams.length; i++) {
      const oV = origVStreams[i];
      const nV = outVStreams[i];
      if (oV.packetCount <= 0 || nV.packetCount <= 0) {
        return { ok: false, reason: `Video stream [${i}] packet count missing or non-positive: ${oV.packetCount} vs ${nV.packetCount}`, details: { oV, nV } };
      }
      if (oV.packetCount !== nV.packetCount) {
        return { ok: false, reason: `Video stream [${i}] packet count mismatch: ${oV.packetCount} vs ${nV.packetCount}`, details: { oV, nV } };
      }
    }

    // 2. Check audio packet counts
    const origAStreams = origStreams.filter(s => s.codecType === 'audio');
    const outAStreams = outStreams.filter(s => s.codecType === 'audio');
    if (origAStreams.length !== outAStreams.length || origAStreams.length !== origFacts.audioCount) {
      return { ok: false, reason: `Audio stream count mismatch in packet probe: ${origAStreams.length} vs ${outAStreams.length}`, details: {} };
    }
    for (let i = 0; i < origAStreams.length; i++) {
      const oA = origAStreams[i];
      const nA = outAStreams[i];
      if (oA.packetCount <= 0 || nA.packetCount <= 0) {
        return { ok: false, reason: `Audio stream [${i}] packet count missing or non-positive: ${oA.packetCount} vs ${nA.packetCount}`, details: { oA, nA } };
      }
      if (oA.packetCount !== nA.packetCount) {
        return { ok: false, reason: `Audio stream [${i}] packet count mismatch: ${oA.packetCount} vs ${nA.packetCount}`, details: { oA, nA } };
      }
    }

    // 3. Check output topology: strictly 1 known muxer-generated chapter representation
    const outOtherFacts = outFacts.otherStreams || [];
    if (outOtherFacts.length !== 1) {
      return {
        ok: false,
        reason: `Chapter-aware output topology requires exactly 1 non-A/V chapter stream, found ${outOtherFacts.length}`,
        details: { outOtherFacts }
      };
    }
    const chStream = outOtherFacts[0];
    const chType = (chStream.codecType || '').toLowerCase();
    const chName = (chStream.codecName || '').toLowerCase();
    const chTag = (chStream.codecTag || '').toLowerCase();
    if (chType !== 'data' || !['bin_data', 'text'].includes(chName) || !['text', 'bin_data', ''].includes(chTag)) {
      return {
        ok: false,
        reason: `Chapter output stream [type=${chType}, codec=${chName}, tag=${chTag}] is not a recognized muxer-generated chapter representation`,
        details: { chStream }
      };
    }

    const outOtherPacketStreams = outStreams.filter(s => s.codecType !== 'video' && s.codecType !== 'audio');
    if (outOtherPacketStreams.length !== 1) {
      return {
        ok: false,
        reason: `Chapter output packet probe requires exactly 1 non-A/V stream, found ${outOtherPacketStreams.length}`,
        details: { outOtherPacketStreams }
      };
    }

    // 4. Elementary payload MD5 equality for Video
    const md5Fn = options.getStreamPayloadMD5 || getStreamPayloadMD5;
    for (let vIdx = 0; vIdx < origVideoCount; vIdx++) {
      if (options.isCancelled?.()) return { ok: false, reason: 'Verification cancelled', details: {} };
      const origVideoMd5 = await md5Fn(originalPath, `0:v:${vIdx}`, options);
      const outVideoMd5 = await md5Fn(outputPath, `0:v:${vIdx}`, options);
      if (!origVideoMd5 || !outVideoMd5) {
        return { ok: false, reason: `Video stream [${vIdx}] payload MD5 could not be computed`, details: {} };
      }
      if (origVideoMd5 !== outVideoMd5) {
        return { ok: false, reason: `Video stream [${vIdx}] elementary payload MD5 mismatch: ${origVideoMd5} vs ${outVideoMd5}`, details: {} };
      }
    }

    // 5. Elementary payload MD5 equality for Audio
    for (let aIdx = 0; aIdx < origFacts.audioCount; aIdx++) {
      if (options.isCancelled?.()) return { ok: false, reason: 'Verification cancelled', details: {} };
      const origAudioMd5 = await md5Fn(originalPath, `0:a:${aIdx}`, options);
      const outAudioMd5 = await md5Fn(outputPath, `0:a:${aIdx}`, options);
      if (!origAudioMd5 || !outAudioMd5) {
        return { ok: false, reason: `Audio stream [${aIdx}] payload MD5 could not be computed`, details: {} };
      }
      if (origAudioMd5 !== outAudioMd5) {
        return { ok: false, reason: `Audio stream [${aIdx}] elementary payload MD5 mismatch: ${origAudioMd5} vs ${outAudioMd5}`, details: {} };
      }
    }

    // 6. Chapter Semantic Equality Verification
    const origChapters = origFacts.chapters || [];
    const outChapters = outFacts.chapters || [];
    if (origChapters.length === 0) {
      return { ok: false, reason: 'Chapter-aware rule requires chapters in source media, but none found', details: {} };
    }
    if (origChapters.length !== outChapters.length) {
      return { ok: false, reason: `Chapter count mismatch: original ${origChapters.length} vs output ${outChapters.length}`, details: { origChapters, outChapters } };
    }

    const TOLERANCE_SEC = 0.005; // 5ms tolerance for container timebase quantization
    for (let cIdx = 0; cIdx < origChapters.length; cIdx++) {
      const oC = origChapters[cIdx];
      const nC = outChapters[cIdx];

      const startDiff = Math.abs(oC.start - nC.start);
      if (startDiff > TOLERANCE_SEC) {
        return { ok: false, reason: `Chapter [${cIdx}] start time drift: ${oC.start}s vs ${nC.start}s (drift: ${startDiff}s > ${TOLERANCE_SEC}s)`, details: { oC, nC } };
      }
      const endDiff = Math.abs(oC.end - nC.end);
      if (endDiff > TOLERANCE_SEC) {
        return { ok: false, reason: `Chapter [${cIdx}] end time drift: ${oC.end}s vs ${nC.end}s (drift: ${endDiff}s > ${TOLERANCE_SEC}s)`, details: { oC, nC } };
      }

      const oTitle = (oC.title || '').trim();
      const nTitle = (nC.title || '').trim();
      if (oTitle !== nTitle) {
        return { ok: false, reason: `Chapter [${cIdx}] title drift: "${oTitle}" vs "${nTitle}"`, details: { oC, nC } };
      }

      // Chapter language equality: if present on either source or output, normalized languages must match exactly
      const oLang = (oC.tags?.language || oC.tags?.LANGUAGE || '').trim().toLowerCase();
      const nLang = (nC.tags?.language || nC.tags?.LANGUAGE || '').trim().toLowerCase();
      if (oLang || nLang) {
        if (oLang !== nLang) {
          return {
            ok: false,
            reason: `Chapter [${cIdx}] language tag mismatch or missing: source "${oLang}" vs output "${nLang}"`,
            details: { oC, nC }
          };
        }
      }
    }

    return {
      ok: true,
      reason: null,
      details: {
        originalFingerprint: origFacts.fingerprint,
        outputFingerprint: outFacts.fingerprint,
        codecTag: primaryOutVideo.codecTag,
        demuxChecked: true,
        videoStreamsVerified: origVideoCount,
        audioStreamsVerified: origFacts.audioCount,
        allRetainedStreamsVerified: outStreams.length,
        chaptersVerified: origChapters.length,
        chapterAware: true
      }
    };
  }

  // Fallback for Existing Normal Rule: strictly preserves 100% of existing behavior
  if (origStreams.length !== outStreams.length) {
    return { ok: false, reason: `Total stream count mismatch: ${origStreams.length} vs ${outStreams.length}`, details: {} };
  }
  for (let i = 0; i < origStreams.length; i++) {
    const oS = origStreams[i];
    const nS = outStreams[i];
    if (oS.codecType !== nS.codecType || oS.codecName !== nS.codecName) {
      return { ok: false, reason: `Stream [${i}] identity mismatch: ${oS.codecType}/${oS.codecName} vs ${nS.codecType}/${nS.codecName}`, details: { oS, nS } };
    }
    if (oS.packetCount <= 0 || nS.packetCount <= 0) {
      return { ok: false, reason: `Stream [${i}] packet count missing or non-positive: ${oS.packetCount} vs ${nS.packetCount}`, details: { oS, nS } };
    }
    if (oS.packetCount !== nS.packetCount) {
      return { ok: false, reason: `Stream [${i}] packet count mismatch: ${oS.packetCount} vs ${nS.packetCount}`, details: { oS, nS } };
    }
  }

  if (options.isCancelled?.()) {
    return { ok: false, reason: 'Verification cancelled', details: {} };
  }

  // 6. Per-Stream Elementary Payload MD5 Equality across all retained streams (P0-5 Fail-Closed)
  // Video payload hash check for all video streams
  for (let vIdx = 0; vIdx < origVideoCount; vIdx++) {
    if (options.isCancelled?.()) {
      return { ok: false, reason: 'Verification cancelled', details: {} };
    }
    const origVideoMd5 = await getStreamPayloadMD5(originalPath, `0:v:${vIdx}`, options);
    const outVideoMd5 = await getStreamPayloadMD5(outputPath, `0:v:${vIdx}`, options);
    if (!origVideoMd5 || !outVideoMd5) {
      return { ok: false, reason: `Video stream [${vIdx}] payload MD5 could not be computed (returned null)`, details: {} };
    }
    if (origVideoMd5 !== outVideoMd5) {
      return { ok: false, reason: `Video stream [${vIdx}] elementary payload MD5 mismatch: ${origVideoMd5} vs ${outVideoMd5}`, details: {} };
    }
  }

  // Audio payload hash check for all audio streams
  for (let aIdx = 0; aIdx < origFacts.audioCount; aIdx++) {
    if (options.isCancelled?.()) {
      return { ok: false, reason: 'Verification cancelled', details: {} };
    }
    const origAudioMd5 = await getStreamPayloadMD5(originalPath, `0:a:${aIdx}`, options);
    const outAudioMd5 = await getStreamPayloadMD5(outputPath, `0:a:${aIdx}`, options);
    if (!origAudioMd5 || !outAudioMd5) {
      return { ok: false, reason: `Audio stream [${aIdx}] payload MD5 could not be computed (returned null)`, details: {} };
    }
    if (origAudioMd5 !== outAudioMd5) {
      return { ok: false, reason: `Audio stream [${aIdx}] payload MD5 mismatch: ${origAudioMd5} vs ${outAudioMd5}`, details: {} };
    }
  }

  // Check any other stream types retained by -map 0 (e.g. subtitles)
  const otherStreams = origStreams.filter(s => s.codecType !== 'video' && s.codecType !== 'audio');
  for (let sIdx = 0; sIdx < otherStreams.length; sIdx++) {
    const s = otherStreams[sIdx];
    if (s.codecType === 'subtitle') {
      const origSubMd5 = await getStreamPayloadMD5(originalPath, `0:s:${sIdx}`, options);
      const outSubMd5 = await getStreamPayloadMD5(outputPath, `0:s:${sIdx}`, options);
      if (!origSubMd5 || !outSubMd5 || origSubMd5 !== outSubMd5) {
        return { ok: false, reason: `Subtitle stream [${sIdx}] payload MD5 mismatch or unavailable`, details: {} };
      }
    } else {
      // Unrecognized stream type in MP4 container cannot be reliably verified
      return { ok: false, reason: `Unverifiable stream type [${s.codecType}] retained in container; destructive execution disallowed`, details: { stream: s } };
    }
  }

  return {
    ok: true,
    reason: null,
    details: {
      originalFingerprint: origFacts.fingerprint,
      outputFingerprint: outFacts.fingerprint,
      codecTag: primaryOutVideo.codecTag,
      demuxChecked: true,
      videoStreamsVerified: origVideoCount,
      audioStreamsVerified: origFacts.audioCount,
      allRetainedStreamsVerified: origStreams.length
    }
  };
}

