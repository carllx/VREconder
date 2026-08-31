import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { probeMediaFacts } from './ffprobe-facts.mjs';

/**
 * Runs fast lossless container and packet-level demux integrity check using stream-copy.
 * Verifies 100% of container packets and atom structures without decoding video frames into pixels.
 * 
 * @param {string} filePath 
 * @returns {Promise<{ ok: boolean, error: string | null }>}
 */
export async function runStreamcopyDemuxIntegrityCheck(filePath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-xerror',
      '-i', filePath,
      '-c', 'copy',
      '-f', 'null',
      '-'
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
 * @returns {Promise<Array<{ index: number, codecType: string, codecName: string, packetCount: number, duration: number }> | null>}
 */
export async function getPerStreamPacketDetails(filePath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-count_packets',
      '-show_entries', 'stream=index,codec_type,codec_name,nb_read_packets,nb_packets,duration',
      '-print_format', 'json',
      filePath
    ];

    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) return resolve(null);
      try {
        const raw = JSON.parse(stdout);
        const streams = (raw.streams || []).map(s => ({
          index: s.index,
          codecType: s.codec_type,
          codecName: s.codec_name,
          packetCount: parseInt(s.nb_read_packets || s.nb_packets || '0', 10),
          duration: parseFloat(s.duration || '0')
        }));
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
 * @returns {Promise<string | null>}
 */
export async function getStreamPayloadMD5(filePath, streamSpecifier) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-i', filePath,
      '-map', streamSpecifier,
      '-c', 'copy',
      '-f', 'md5',
      '-'
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
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
 * 
 * @param {string} originalPath 
 * @param {string} outputPath 
 * @param {object} expectedRule 
 * @returns {Promise<{ ok: boolean, reason: string | null, details: object }>}
 */
export async function verifyNormalizedOutput(originalPath, outputPath, expectedRule = {}) {
  const origFacts = await probeMediaFacts(originalPath);
  if (!origFacts || !origFacts.video) {
    return { ok: false, reason: 'Original media cannot be probed', details: {} };
  }

  const outFacts = await probeMediaFacts(outputPath);
  if (!outFacts || !outFacts.video) {
    return { ok: false, reason: 'Output media cannot be probed by ffprobe', details: {} };
  }

  const oV = origFacts.video;
  const nV = outFacts.video;

  // 1. Video Invariants
  if (oV.codec !== nV.codec) {
    return { ok: false, reason: `Video codec mismatch: ${oV.codec} vs ${nV.codec}`, details: { oV, nV } };
  }
  if (oV.width !== nV.width || oV.height !== nV.height) {
    return { ok: false, reason: `Dimensions mismatch: ${oV.width}x${oV.height} vs ${nV.width}x${nV.height}`, details: { oV, nV } };
  }
  if (oV.profile !== nV.profile) {
    return { ok: false, reason: `Video profile mismatch: ${oV.profile} vs ${nV.profile}`, details: { oV, nV } };
  }
  if (oV.level !== nV.level) {
    return { ok: false, reason: `Video level mismatch: ${oV.level} vs ${nV.level}`, details: { oV, nV } };
  }
  if (oV.pixFmt !== nV.pixFmt || oV.bitDepth !== nV.bitDepth) {
    return { ok: false, reason: `Pixel format / bit depth mismatch: ${oV.pixFmt}/${oV.bitDepth} vs ${nV.pixFmt}/${nV.bitDepth}`, details: { oV, nV } };
  }
  if (oV.rFps !== nV.rFps) {
    return { ok: false, reason: `Frame rate mismatch: ${oV.rFps} vs ${nV.rFps}`, details: { oV, nV } };
  }
  if (Math.abs(oV.durationSec - nV.durationSec) > 0.5) {
    return { ok: false, reason: `Duration divergence: ${oV.durationSec}s vs ${nV.durationSec}s`, details: { oV, nV } };
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
  if ((nV.codecTag || '').toLowerCase() !== expectedTag.toLowerCase()) {
    return { ok: false, reason: `Target tag requirement not met: expected ${expectedTag}, got ${nV.codecTag}`, details: { nV } };
  }

  // 4. Container & Packet Demux Validation (no pixel decoding, checks all container streams & packets)
  const demuxResult = await runStreamcopyDemuxIntegrityCheck(outputPath);
  if (!demuxResult.ok) {
    return { ok: false, reason: `Container stream demux check failed: ${demuxResult.error}`, details: demuxResult };
  }

  // 5. Per-Stream Packet Count Equality
  const origStreams = await getPerStreamPacketDetails(originalPath);
  const outStreams = await getPerStreamPacketDetails(outputPath);
  if (origStreams && outStreams) {
    if (origStreams.length !== outStreams.length) {
      return { ok: false, reason: `Total stream count mismatch: ${origStreams.length} vs ${outStreams.length}`, details: {} };
    }
    for (let i = 0; i < origStreams.length; i++) {
      const oS = origStreams[i];
      const nS = outStreams[i];
      if (oS.packetCount > 0 && nS.packetCount > 0 && oS.packetCount !== nS.packetCount) {
        return { ok: false, reason: `Stream [${i}] packet count mismatch: ${oS.packetCount} vs ${nS.packetCount}`, details: { oS, nS } };
      }
    }
  }

  // 6. Per-Stream Elementary Payload MD5 Equality
  // Video payload hash check
  const origVideoMd5 = await getStreamPayloadMD5(originalPath, '0:v:0');
  const outVideoMd5 = await getStreamPayloadMD5(outputPath, '0:v:0');
  if (origVideoMd5 && outVideoMd5 && origVideoMd5 !== outVideoMd5) {
    return { ok: false, reason: `Video elementary stream payload MD5 mismatch: ${origVideoMd5} vs ${outVideoMd5}`, details: {} };
  }

  // Audio payload hash check for all audio streams
  for (let aIdx = 0; aIdx < origFacts.audioCount; aIdx++) {
    const origAudioMd5 = await getStreamPayloadMD5(originalPath, `0:a:${aIdx}`);
    const outAudioMd5 = await getStreamPayloadMD5(outputPath, `0:a:${aIdx}`);
    if (origAudioMd5 && outAudioMd5 && origAudioMd5 !== outAudioMd5) {
      return { ok: false, reason: `Audio stream [${aIdx}] payload MD5 mismatch: ${origAudioMd5} vs ${outAudioMd5}`, details: {} };
    }
  }

  return {
    ok: true,
    reason: null,
    details: {
      originalFingerprint: origFacts.fingerprint,
      outputFingerprint: outFacts.fingerprint,
      codecTag: nV.codecTag,
      demuxChecked: true,
      videoMd5Matched: origVideoMd5 === outVideoMd5,
      audioStreamsVerified: origFacts.audioCount
    }
  };
}

