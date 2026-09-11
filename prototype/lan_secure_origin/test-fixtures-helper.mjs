import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function createSyntheticHevcFixture(targetPath, duration = 0.2) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

  const res = spawnSync('ffmpeg', [
    '-v', 'error',
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=4096x2048:d=${duration}:r=60000/1001`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-tag:v', 'hev1', '-t', `${duration}`,
    '-c:a', 'aac', '-t', `${duration}`,
    targetPath
  ], { encoding: 'utf8' });

  if (res.status !== 0 || !fs.existsSync(targetPath)) {
    throw new Error(`Failed to create synthetic fixture: ${res.stderr}`);
  }
  return targetPath;
}

export function createMultiVideoFixture(targetPath, duration = 0.2) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

  const res = spawnSync('ffmpeg', [
    '-v', 'error',
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=128x128:d=${duration}:r=30/1`,
    '-f', 'lavfi', '-i', `color=c=white:s=128x128:d=${duration}:r=30/1`,
    '-map', '0:v', '-map', '1:v',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-tag:v', 'hev1', '-t', `${duration}`,
    targetPath
  ], { encoding: 'utf8' });

  if (res.status !== 0 || !fs.existsSync(targetPath)) {
    throw new Error(`Failed to create multi-video fixture: ${res.stderr}`);
  }
  return targetPath;
}
