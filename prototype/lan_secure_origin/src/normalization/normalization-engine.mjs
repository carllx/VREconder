import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { NormalizationJournal, NormalizationState } from './journal.mjs';
import { getDiskFreeSpace } from './inventory-scanner.mjs';
import { probeMediaFacts } from './ffprobe-facts.mjs';
import { verifyNormalizedOutput } from './verifier.mjs';
import { findRepairCandidate } from './repair-rules.mjs';

export class NormalizationEngine {
  constructor(options = {}) {
    this.journal = options.journal || new NormalizationJournal(options.journalPath || path.join(process.cwd(), 'prototype/lan_secure_origin/normalization_journal.json'));
    this.executionEnabled = options.executionEnabled ?? false; // Hard safety gate: disabled by default
    this.activeChildProcess = null;
    this.activeJob = null;
    this.isPlaybackActive = false;
    this.concurrency = 1;
    this.isProcessing = false;
  }

  notifyPlaybackState(isActive) {
    this.isPlaybackActive = !!isActive;
    if (this.isPlaybackActive && this.activeJob) {
      console.log(`[NormalizationEngine] Playback active! Pausing / cancelling active job: ${this.activeJob.originalPath}`);
      this.cancelActiveJobForPlayback();
    }
  }

  cancelActiveJobForPlayback() {
    if (this.activeChildProcess) {
      try {
        this.activeChildProcess.kill('SIGTERM');
      } catch (e) {}
      this.activeChildProcess = null;
    }
    if (this.activeJob) {
      const { partialPath, originalPath } = this.activeJob;
      if (fs.existsSync(partialPath)) {
        try { fs.unlinkSync(partialPath); } catch (_) {}
      }
      this.journal.recordState(originalPath, NormalizationState.PAUSED_FOR_PLAYBACK, {
        reason: 'Active playback initiated',
        pausedAt: new Date().toISOString()
      });
      this.activeJob = null;
      this.isProcessing = false;
    }
  }

  /**
   * Executes in-place normalization for a single candidate file.
   * 
   * @param {string} originalPath 
   * @returns {Promise<{ ok: boolean, state: string, error?: string }>}
   */
  async processCandidate(originalPath) {
    if (!this.executionEnabled) {
      return {
        ok: false,
        state: NormalizationState.FAILED_SAFE,
        error: 'Execution is disabled by mission safety gate. Set executionEnabled: true to authorize.'
      };
    }

    if (this.isPlaybackActive) {
      return {
        ok: false,
        state: NormalizationState.PAUSED_FOR_PLAYBACK,
        error: 'Blocked by active playback priority'
      };
    }

    if (this.isProcessing) {
      return {
        ok: false,
        state: NormalizationState.FAILED_SAFE,
        error: 'Concurrency limit (1) exceeded'
      };
    }

    this.isProcessing = true;
    const canonical = path.normalize(path.resolve(originalPath));
    if (!fs.existsSync(canonical)) {
      this.isProcessing = false;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'Target file not found' };
    }

    const stat = fs.statSync(canonical);
    const requiredFree = Math.ceil(stat.size * 1.2);
    const available = getDiskFreeSpace(canonical);

    if (available >= 0 && available < requiredFree) {
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, {
        error: 'BLOCKED_NO_SPACE',
        requiredFree,
        available
      });
      this.isProcessing = false;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'BLOCKED_NO_SPACE' };
    }

    const dir = path.dirname(canonical);
    const ext = path.extname(canonical);
    const base = path.basename(canonical, ext);
    const partialPath = path.join(dir, `.${base}${ext}.vreconder.partial`);
    const oldPath = path.join(dir, `.${base}${ext}.vreconder-old`);

    const facts = await probeMediaFacts(canonical);
    const rule = findRepairCandidate(facts, ext);
    if (!rule) {
      this.isProcessing = false;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'No applicable repair candidate rule' };
    }

    // Phase 1: PENDING
    this.journal.recordState(canonical, NormalizationState.PENDING, { ruleId: rule.id });

    // Clean any previous stale partial
    if (fs.existsSync(partialPath)) {
      try { fs.unlinkSync(partialPath); } catch (_) {}
    }

    // Phase 2: REMUXING
    this.journal.recordState(canonical, NormalizationState.REMUXING, { partialPath });
    this.activeJob = { originalPath: canonical, partialPath, oldPath };

    const remuxResult = await new Promise((resolve) => {
      const args = [
        '-v', 'error',
        '-y',
        '-i', canonical,
        '-c', 'copy',
        '-tag:v', rule.expectedOutputTag || 'hvc1',
        '-movflags', '+faststart',
        partialPath
      ];

      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.activeChildProcess = child;
      let stderr = '';

      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
      child.on('close', (code) => {
        this.activeChildProcess = null;
        if (code === 0 && fs.existsSync(partialPath)) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: stderr.trim() || `ffmpeg exited with code ${code}` });
        }
      });
    });

    if (!remuxResult.ok || this.isPlaybackActive) {
      if (fs.existsSync(partialPath)) try { fs.unlinkSync(partialPath); } catch (_) {}
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: remuxResult.error || 'Interrupted' });
      this.activeJob = null;
      this.isProcessing = false;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: remuxResult.error };
    }

    // Phase 3: STRUCTURE_VERIFYING
    this.journal.recordState(canonical, NormalizationState.STRUCTURE_VERIFYING);
    const structVerify = await verifyNormalizedOutput(canonical, partialPath, rule);
    if (!structVerify.ok) {
      if (fs.existsSync(partialPath)) try { fs.unlinkSync(partialPath); } catch (_) {}
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: structVerify.reason });
      this.activeJob = null;
      this.isProcessing = false;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: structVerify.reason };
    }

    // Phase 4: VERIFIED
    this.journal.recordState(canonical, NormalizationState.VERIFIED);

    // Phase 5: SWAPPING
    this.journal.recordState(canonical, NormalizationState.SWAPPING);
    try {
      if (fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch (_) {}
      fs.renameSync(canonical, oldPath);
      fs.renameSync(partialPath, canonical);
    } catch (swapErr) {
      // Rollback swap
      if (fs.existsSync(oldPath) && !fs.existsSync(canonical)) {
        try { fs.renameSync(oldPath, canonical); } catch (_) {}
      }
      if (fs.existsSync(partialPath)) try { fs.unlinkSync(partialPath); } catch (_) {}
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: `Swap failed: ${swapErr.message}` });
      this.activeJob = null;
      this.isProcessing = false;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: swapErr.message };
    }

    // Phase 6: FINAL_VERIFYING
    this.journal.recordState(canonical, NormalizationState.FINAL_VERIFYING);
    const finalVerify = await verifyNormalizedOutput(oldPath, canonical, rule);
    if (!finalVerify.ok) {
      // Emergency rollback: restore old file over corrupted new file
      try {
        if (fs.existsSync(canonical)) fs.unlinkSync(canonical);
        fs.renameSync(oldPath, canonical);
      } catch (_) {}
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: `Final verify failed: ${finalVerify.reason}` });
      this.activeJob = null;
      this.isProcessing = false;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: finalVerify.reason };
    }

    // Phase 7: DONE (Only now is old file unlinked)
    try {
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    } catch (unlinkErr) {
      console.warn(`[NormalizationEngine] Warning: Could not unlink old file: ${unlinkErr.message}`);
    }

    this.journal.recordState(canonical, NormalizationState.DONE, {
      completedAt: new Date().toISOString()
    });

    this.activeJob = null;
    this.isProcessing = false;
    return { ok: true, state: NormalizationState.DONE };
  }
}
