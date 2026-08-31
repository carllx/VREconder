import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getMediaFingerprint } from './fingerprint.mjs';

const factsMemoryCache = new Map();

/**
 * Checks whether an MP4/MOV container has the 'moov' atom before 'mdat' (faststart).
 * Reads the top-level atom headers without reading the entire file.
 * 
 * @param {string} filePath 
 * @returns {Promise<'moov_first' | 'mdat_first' | 'unknown'>}
 */
export async function inspectMoovPlacement(filePath) {
  return new Promise((resolve) => {
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(1024 * 1024); // read first 1MB
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      fd = null;

      let offset = 0;
      let moovOffset = -1;
      let mdatOffset = -1;

      while (offset + 8 <= bytesRead) {
        let size = buf.readUInt32BE(offset);
        const type = buf.toString('ascii', offset + 4, offset + 8);

        if (type === 'moov' && moovOffset === -1) moovOffset = offset;
        if (type === 'mdat' && mdatOffset === -1) mdatOffset = offset;

        if (moovOffset !== -1 && mdatOffset !== -1) break;

        if (size === 1) {
          // 64-bit large size
          if (offset + 16 > bytesRead) break;
          // approximate jump
          offset += 16;
          break;
        } else if (size <= 0) {
          break;
        }
        offset += size;
      }

      if (moovOffset !== -1 && (mdatOffset === -1 || moovOffset < mdatOffset)) {
        return resolve('moov_first');
      }
      if (mdatOffset !== -1 && (moovOffset === -1 || mdatOffset < moovOffset)) {
        return resolve('mdat_first');
      }
      resolve('unknown');
    } catch (e) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_) {}
      }
      resolve('unknown');
    }
  });
}

/**
 * Runs ffprobe on a file and extracts structured facts.
 * 
 * @param {string} filePath 
 * @returns {Promise<object | null>}
 */
export async function probeMediaFacts(filePath) {
  const fp = getMediaFingerprint(filePath);
  if (!fp) return null;

  if (factsMemoryCache.has(fp.fingerprintId)) {
    return factsMemoryCache.get(fp.fingerprintId);
  }

  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];

    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', () => resolve(null));

    child.on('close', async (code) => {
      if (code !== 0 || !stdout.trim()) {
        return resolve(null);
      }

      try {
        const raw = JSON.parse(stdout);
        const format = raw.format || {};
        const streams = raw.streams || [];

        const videoStream = streams.find(s => s.codec_type === 'video') || null;
        const audioStreams = streams.filter(s => s.codec_type === 'audio');

        let videoCodec = videoStream ? videoStream.codec_name : 'unknown';
        let videoTag = videoStream ? (videoStream.codec_tag_string || '').replace(/[^\x20-\x7E]/g, '').trim() : '';
        let profile = videoStream ? (videoStream.profile || 'unknown') : 'unknown';
        let level = videoStream ? (videoStream.level ?? -1) : -1;
        let pixFmt = videoStream ? (videoStream.pix_fmt || 'unknown') : 'unknown';
        let bitDepth = 8;
        if (videoStream && videoStream.bits_per_raw_sample) {
          bitDepth = parseInt(videoStream.bits_per_raw_sample, 10);
        } else if (pixFmt.includes('10') || pixFmt.includes('p010') || profile.toLowerCase().includes('main 10')) {
          bitDepth = 10;
        }

        const width = videoStream ? (videoStream.width || 0) : 0;
        const height = videoStream ? (videoStream.height || 0) : 0;
        const rFps = videoStream ? (videoStream.r_frame_rate || '') : '';
        const avgFps = videoStream ? (videoStream.avg_frame_rate || '') : '';
        const durationSec = parseFloat(format.duration || (videoStream ? videoStream.duration : 0)) || 0;

        const moovLocation = await inspectMoovPlacement(filePath);

        const facts = {
          fingerprint: fp,
          containerFormat: format.format_name || path.extname(filePath).slice(1),
          video: videoStream ? {
            codec: videoCodec,
            codecTag: videoTag,
            profile,
            level,
            pixFmt,
            bitDepth,
            width,
            height,
            rFps,
            avgFps,
            durationSec
          } : null,
          audioCount: audioStreams.length,
          audioStreams: audioStreams.map(a => ({
            codec: a.codec_name,
            channels: a.channels,
            sampleRate: a.sample_rate
          })),
          moovLocation,
          probedAt: new Date().toISOString()
        };

        factsMemoryCache.set(fp.fingerprintId, facts);
        resolve(facts);
      } catch (err) {
        resolve(null);
      }
    });
  });
}

/**
 * Clears the facts memory cache.
 */
export function clearFactsCache() {
  factsMemoryCache.clear();
}
