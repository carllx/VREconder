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

function resolveBitDepthFromStream(videoStream) {
  if (!videoStream) return null;
  if (videoStream.bits_per_raw_sample) {
    const rawBps = parseInt(videoStream.bits_per_raw_sample, 10);
    if (!isNaN(rawBps) && rawBps > 0) {
      return rawBps;
    }
  }
  const lowerPix = (videoStream.pix_fmt || '').toLowerCase();
  const lowerProf = (videoStream.profile || '').toLowerCase();
  if (lowerPix.includes('10') || lowerPix.includes('p010') || lowerProf.includes('main 10') || lowerProf.includes('high 10')) {
    return 10;
  }
  if (['yuv420p', 'yuvj420p', 'nv12', 'nv21', 'yuv422p', 'yuvj422p', 'yuv444p', 'yuvj444p', 'rgb24', 'bgr24', 'rgba', 'bgra', 'gbrp'].includes(lowerPix) && !lowerProf.includes('10')) {
    return 8;
  }
  return null;
}

function mapVideoStreamFact(v) {
  if (!v) return null;
  return {
    codec: v.codec_name || 'unknown',
    codecTag: (v.codec_tag_string || '').replace(/[^\x20-\x7E]/g, '').trim(),
    profile: v.profile || 'unknown',
    level: v.level ?? -1,
    pixFmt: v.pix_fmt || 'unknown',
    bitDepth: resolveBitDepthFromStream(v),
    width: v.width || 0,
    height: v.height || 0,
    rFps: v.r_frame_rate || '',
    avgFps: v.avg_frame_rate || '',
    durationSec: parseFloat(v.duration || '0')
  };
}

/**
 * Runs ffprobe on a file and extracts structured facts.
 * Supports job-scoped child process registration and cancellation.
 * 
 * @param {string} filePath 
 * @param {object} options - { onChildProcess, isCancelled }
 * @returns {Promise<object | null>}
 */
export async function probeMediaFacts(filePath, options = {}) {
  if (options.isCancelled?.()) return null;
  const fp = getMediaFingerprint(filePath);
  if (!fp) return null;

  if (factsMemoryCache.has(fp.fingerprintId)) {
    return factsMemoryCache.get(fp.fingerprintId);
  }

  return new Promise((resolve) => {
    if (options.isCancelled?.()) return resolve(null);
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      filePath
    ];

    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    options.onChildProcess?.(child);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', () => resolve(null));

    child.on('close', async (code) => {
      if (options.isCancelled?.()) return resolve(null);
      if (code !== 0 || !stdout.trim()) {
        return resolve(null);
      }

      try {
        const raw = JSON.parse(stdout);
        const format = raw.format || {};
        const streams = raw.streams || [];

        const videoStreams = streams.filter(s => s.codec_type === 'video');
        const audioStreams = streams.filter(s => s.codec_type === 'audio');
        const subtitleStreams = streams.filter(s => s.codec_type === 'subtitle');
        const otherStreams = streams.filter(s => s.codec_type !== 'video' && s.codec_type !== 'audio');

        const chapters = (raw.chapters || []).map(ch => ({
          id: ch.id,
          start: parseFloat(ch.start_time || '0'),
          end: parseFloat(ch.end_time || '0'),
          title: (ch.tags?.title || ch.tags?.TITLE || '').trim(),
          tags: ch.tags || {}
        }));

        const primaryVideo = videoStreams[0] || null;
        const primaryVideoFact = mapVideoStreamFact(primaryVideo);
        if (primaryVideoFact && format.duration && !primaryVideoFact.durationSec) {
          primaryVideoFact.durationSec = parseFloat(format.duration) || 0;
        }

        const moovLocation = await inspectMoovPlacement(filePath);

        const facts = {
          fingerprint: fp,
          containerFormat: format.format_name || path.extname(filePath).slice(1),
          streamCount: streams.length,
          videoCount: videoStreams.length,
          videoStreams: videoStreams.map(v => mapVideoStreamFact(v)),
          video: primaryVideoFact,
          audioCount: audioStreams.length,
          audioStreams: audioStreams.map(a => ({
            codec: a.codec_name,
            channels: a.channels,
            sampleRate: a.sample_rate
          })),
          subtitleCount: subtitleStreams.length,
          otherStreams: otherStreams.map(s => ({
            index: s.index,
            codecType: s.codec_type,
            codecName: s.codec_name || 'unknown',
            codecTag: (s.codec_tag_string || '').replace(/[^\x20-\x7E]/g, '').trim(),
            handler: s.tags?.handler_name || ''
          })),
          chapterCount: chapters.length,
          chapters,
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
