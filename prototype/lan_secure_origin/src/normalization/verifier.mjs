import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { probeMediaFacts } from './ffprobe-facts.mjs';

/**
 * Runs full demux decoding check with ffmpeg on a media file.
 * Returns true if ffmpeg decodes/demuxes all streams with zero errors.
 * 
 * @param {string} filePath 
 * @returns {Promise<{ ok: boolean, error: string | null }>}
 */
export async function runFullDemuxCheck(filePath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-xerror',
      '-i', filePath,
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
        resolve({ ok: false, error: stderr.trim() || `ffmpeg exited with code ${code}` });
      }
    });
  });
}

/**
 * Counts stream packets and duration using ffprobe for deep payload verification.
 * 
 * @param {string} filePath 
 * @returns {Promise<{ packetCount: number, streamCount: number } | null>}
 */
export async function getStreamPacketSummary(filePath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-count_packets',
      '-show_entries', 'stream=nb_read_packets,nb_packets,codec_type,codec_name',
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
        const streams = raw.streams || [];
        let totalPackets = 0;
        for (const s of streams) {
          const count = parseInt(s.nb_read_packets || s.nb_packets || '0', 10);
          totalPackets += count;
        }
        resolve({ packetCount: totalPackets, streamCount: streams.length });
      } catch (e) {
        resolve(null);
      }
    });
  });
}

/**
 * Verifies that a normalized output file satisfies all structural, stream, and payload invariants
 * when compared against the original source.
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

  // 1. Invariants check
  if (oV.codec !== nV.codec) {
    return { ok: false, reason: `Codec mismatch: original ${oV.codec} vs output ${nV.codec}`, details: { oV, nV } };
  }
  if (oV.width !== nV.width || oV.height !== nV.height) {
    return { ok: false, reason: `Dimensions mismatch: ${oV.width}x${oV.height} vs ${nV.width}x${nV.height}`, details: { oV, nV } };
  }
  if (oV.pixFmt !== nV.pixFmt || oV.bitDepth !== nV.bitDepth) {
    return { ok: false, reason: `Pixel format / bit depth mismatch: ${oV.pixFmt}/${oV.bitDepth} vs ${nV.pixFmt}/${nV.bitDepth}`, details: { oV, nV } };
  }
  if (Math.abs(oV.durationSec - nV.durationSec) > 0.5) {
    return { ok: false, reason: `Duration divergence: ${oV.durationSec}s vs ${nV.durationSec}s`, details: { oV, nV } };
  }

  // 2. Audio invariants
  if (origFacts.audioCount !== outFacts.audioCount) {
    return { ok: false, reason: `Audio stream count mismatch: ${origFacts.audioCount} vs ${outFacts.audioCount}`, details: {} };
  }

  // 3. Target packaging check (e.g. tag hvc1 and moov at front)
  const expectedTag = expectedRule.expectedOutputTag || 'hvc1';
  if ((nV.codecTag || '').toLowerCase() !== expectedTag.toLowerCase()) {
    return { ok: false, reason: `Target tag requirement not met: expected ${expectedTag}, got ${nV.codecTag}`, details: { nV } };
  }
  if (outFacts.moovLocation !== 'moov_first') {
    return { ok: false, reason: `Target faststart packaging not met: moov location is ${outFacts.moovLocation}`, details: {} };
  }

  // 4. Full Demux Validation
  const demuxResult = await runFullDemuxCheck(outputPath);
  if (!demuxResult.ok) {
    return { ok: false, reason: `Full demux check failed: ${demuxResult.error}`, details: demuxResult };
  }

  // 5. Packet stream payload validation
  const origPackets = await getStreamPacketSummary(originalPath);
  const outPackets = await getStreamPacketSummary(outputPath);
  if (origPackets && outPackets) {
    if (origPackets.streamCount !== outPackets.streamCount) {
      return { ok: false, reason: `Stream count mismatch: ${origPackets.streamCount} vs ${outPackets.streamCount}`, details: {} };
    }
  }

  return {
    ok: true,
    reason: null,
    details: {
      originalFingerprint: origFacts.fingerprint,
      outputFingerprint: outFacts.fingerprint,
      moovLocation: outFacts.moovLocation,
      codecTag: nV.codecTag,
      demuxChecked: true
    }
  };
}
