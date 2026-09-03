import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { NormalizationJournal, NormalizationState } from './journal.mjs';
import { getDiskFreeSpace } from './inventory-scanner.mjs';
import { probeMediaFacts } from './ffprobe-facts.mjs';
import { getMediaFingerprint, isFingerprintValid } from './fingerprint.mjs';
import { verifyNormalizedOutput } from './verifier.mjs';
import { findRepairCandidate } from './repair-rules.mjs';
import { executeRollback, RollbackStatus } from './rollback-helper.mjs';

export const EngineStatus = {
  UNINITIALIZED: 'UNINITIALIZED',
  SAFE_IDLE: 'SAFE_IDLE',
  PROCESSING: 'PROCESSING',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  PAUSED_FOR_PLAYBACK: 'PAUSED_FOR_PLAYBACK',
  JOURNAL_CORRUPT: 'JOURNAL_CORRUPT',
  RECOVERY_BLOCKED: 'RECOVERY_BLOCKED',
  CLEANUP_PENDING: 'CLEANUP_PENDING',
  SUBPROCESS_JOIN_TIMEOUT: 'SUBPROCESS_JOIN_TIMEOUT'
};

export class NormalizationEngine {
  constructor(options = {}) {
    this.journal = options.journal || new NormalizationJournal(options.journalPath || path.join(process.cwd(), 'prototype/lan_secure_origin/normalization_journal.json'));
    this.executionEnabled = options.executionEnabled ?? false; // Hard safety gate: disabled by default
    this.allowUncertifiedCandidate = options.allowUncertifiedCandidate ?? false; // Explicit candidate staging gate
    this.allowedRoots = options.allowedRoots || null; // Optional isolation guard
    this.fileOps = options.fileOps || {}; // Fault injection hook
    this.getMediaFingerprint = options.getMediaFingerprint || options.fileOps?.getMediaFingerprint || getMediaFingerprint;
    this.spawn = options.spawn || options.fileOps?.spawn || spawn;
    this.status = EngineStatus.UNINITIALIZED;
    this.activeProcesses = new Set();
    this.activeJob = null;
    this.isPlaybackActive = false;
    this.concurrency = 1;
    this.isProcessing = false;
  }

  _registerProcess(child) {
    if (!child) return child;
    this.activeProcesses.add(child);
    const cleanup = () => {
      this.activeProcesses.delete(child);
    };
    child.once('close', cleanup);
    child.once('error', cleanup);
    child.once('exit', cleanup);
    return child;
  }

  async _waitForActiveProcesses(timeoutMs = 10000) {
    if (this.activeProcesses.size === 0) return true;
    const start = Date.now();
    while (this.activeProcesses.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 20));
    }
    return this.activeProcesses.size === 0;
  }

  async initialize() {
    const validation = this.journal.validateJournal();
    if (!validation.ok) {
      this.status = EngineStatus.JOURNAL_CORRUPT;
      return { ok: false, status: EngineStatus.JOURNAL_CORRUPT, details: { error: validation.error } };
    }

    const recovery = this.journal.recoverOnStartup(this.fileOps);
    if (!recovery.ok) {
      this.status = EngineStatus.RECOVERY_BLOCKED;
      return { ok: false, status: EngineStatus.RECOVERY_BLOCKED, details: recovery };
    }

    this.status = EngineStatus.SAFE_IDLE;
    return { ok: true, status: EngineStatus.SAFE_IDLE, details: recovery };
  }

  notifyPlaybackState(isActive) {
    this.isPlaybackActive = !!isActive;
    if (this.isPlaybackActive) {
      if (this.activeJob && !this.activeJob.isCancelled) {
        console.log(`[NormalizationEngine] Playback active! Cancelling active job: ${this.activeJob.originalPath}`);
        this.cancelActiveJobForPlayback();
      } else if (this.isProcessing && this.activeProcesses.size > 0) {
        console.log(`[NormalizationEngine] Playback active! Cancelling active normalization processes.`);
        this.cancelActiveJobForPlayback();
      }
    }
  }

  /**
   * Monotonic single-owner cancellation sequence.
   * Guarantees that rollback, cleanup, and journal state finalization execute exactly once per job.
   */
  async _cancelJobInternal(job, reason, timeoutMs = 10000) {
    if (!job) return { ok: false, state: NormalizationState.PAUSED_FOR_PLAYBACK };
    if (job.cancellationPromise) {
      return job.cancellationPromise;
    }

    job.cancellationPromise = (async () => {
      job.isCancelled = true;
      job.cancelReason = reason || 'PLAYBACK_ACTIVE';
      this.status = EngineStatus.CANCEL_REQUESTED;

      // 1. Terminate all active child processes
      for (const proc of this.activeProcesses) {
        try { proc.kill('SIGTERM'); } catch (_) {}
      }

      // 2. Await join of all subprocesses
      const joined = await this._waitForActiveProcesses(timeoutMs);
      if (!joined) {
        console.error('[NormalizationEngine] FATAL: Child processes failed to exit within timeout during cancellation.');
        this.status = EngineStatus.SUBPROCESS_JOIN_TIMEOUT;
        return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'SUBPROCESS_JOIN_TIMEOUT' };
      }

      // 3. Single-owner rollback execution
      const rollback = executeRollback({
        canonical: job.originalPath,
        oldPath: job.oldPath,
        partialPath: job.partialPath,
        isSwapped: job.isSwapped,
        initialFingerprint: job.initialFingerprint,
        fileOps: this.fileOps
      });

      if (!rollback.ok) {
        console.error(`[NormalizationEngine] FATAL: Rollback failed during cancellation: ${rollback.error}`);
        this.status = EngineStatus.RECOVERY_BLOCKED;
        this.journal.recordState(job.originalPath, NormalizationState.RECOVERY_REQUIRED, {
          error: 'ROLLBACK_FAILED_RECOVERY_REQUIRED',
          rollbackError: rollback.error,
          pausedAt: new Date().toISOString()
        });
        return { ok: false, state: NormalizationState.RECOVERY_REQUIRED, error: rollback.error };
      }

      // 4. Record PAUSED_FOR_PLAYBACK only after proven clean rollback
      this.journal.recordState(job.originalPath, NormalizationState.PAUSED_FOR_PLAYBACK, {
        reason: job.cancelReason,
        pausedAt: new Date().toISOString(),
        initialFingerprint: job.initialFingerprint
      });

      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.PAUSED_FOR_PLAYBACK;
      return { ok: false, state: NormalizationState.PAUSED_FOR_PLAYBACK, error: 'Cancelled for playback' };
    })();

    return job.cancellationPromise;
  }

  async cancelActiveJobForPlayback(timeoutMs = 10000) {
    if (this.activeJob) {
      return this._cancelJobInternal(this.activeJob, 'PLAYBACK_ACTIVE', timeoutMs);
    }
    if (this.isProcessing && this.activeProcesses.size > 0) {
      for (const proc of this.activeProcesses) {
        try { proc.kill('SIGTERM'); } catch (_) {}
      }
      await this._waitForActiveProcesses(timeoutMs);
      this.isProcessing = false;
      this.status = EngineStatus.PAUSED_FOR_PLAYBACK;
    }
  }

  async _handleJobCancellation(job, timeoutMs = 10000) {
    return this._cancelJobInternal(job, job.cancelReason || 'PLAYBACK_ACTIVE', timeoutMs);
  }

  async processCandidate(originalPath) {
    if (
      this.status === EngineStatus.UNINITIALIZED ||
      this.status === EngineStatus.JOURNAL_CORRUPT ||
      this.status === EngineStatus.RECOVERY_BLOCKED ||
      this.status === EngineStatus.CLEANUP_PENDING ||
      this.status === EngineStatus.SUBPROCESS_JOIN_TIMEOUT
    ) {
      return {
        ok: false,
        state: NormalizationState.FAILED_SAFE,
        error: `Engine execution blocked due to health status: ${this.status}`
      };
    }

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

    if (this.isProcessing || this.activeProcesses.size > 0 || this.activeJob) {
      return {
        ok: false,
        state: NormalizationState.FAILED_SAFE,
        error: 'Concurrency limit (1) exceeded or previous child process still exiting'
      };
    }

    this.isProcessing = true;
    this.status = EngineStatus.PROCESSING;

    const canonical = path.normalize(path.resolve(originalPath));

    if (this.allowedRoots && Array.isArray(this.allowedRoots)) {
      const isAllowed = this.allowedRoots.some(root => {
        const rel = path.relative(path.resolve(root), canonical);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!isAllowed) {
        this.isProcessing = false;
        this.status = EngineStatus.SAFE_IDLE;
        return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'Target path is outside allowed roots guard' };
      }
    }

    if (!fs.existsSync(canonical)) {
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'Target file not found' };
    }

    const dir = path.dirname(canonical);
    const ext = path.extname(canonical);
    const base = path.basename(canonical, ext);
    const partialPath = path.join(dir, `.${base}${ext}.vreconder.partial`);
    const oldPath = path.join(dir, `.${base}${ext}.vreconder-old`);

    if (fs.existsSync(oldPath) || fs.existsSync(partialPath)) {
      let entry = null;
      try {
        entry = this.journal.getEntry(canonical);
      } catch (e) {
        this.isProcessing = false;
        this.status = EngineStatus.JOURNAL_CORRUPT;
        return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'JOURNAL_CORRUPT' };
      }

      if (!entry || (entry.currentState === NormalizationState.DONE || entry.currentState === NormalizationState.FAILED_SAFE || entry.currentState === NormalizationState.CANCELLED)) {
        this.journal.recordState(canonical, NormalizationState.RECOVERY_REQUIRED, {
          error: 'BLOCKED_RECOVERY_REQUIRED',
          reason: 'Pre-existing .vreconder-old or .partial artifact found without valid pending journal state'
        });
        this.status = EngineStatus.RECOVERY_BLOCKED;
        return { ok: false, state: NormalizationState.RECOVERY_REQUIRED, error: 'BLOCKED_RECOVERY_REQUIRED' };
      }
    }

    const stat = fs.statSync(canonical);
    const requiredFree = Math.ceil(stat.size * 1.2);
    const available = getDiskFreeSpace(canonical);

    if (available < 0) {
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: 'BLOCKED_SPACE_UNKNOWN', available });
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'BLOCKED_SPACE_UNKNOWN' };
    }

    if (available < requiredFree) {
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: 'BLOCKED_NO_SPACE', requiredFree, available });
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'BLOCKED_NO_SPACE' };
    }

    const initialFingerprint = this.getMediaFingerprint(canonical);
    if (!initialFingerprint || typeof initialFingerprint.sizeBytes !== 'number' || typeof initialFingerprint.mtimeMs !== 'number') {
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'INITIAL_FINGERPRINT_UNAVAILABLE' };
    }

    const job = {
      originalPath: canonical,
      partialPath,
      oldPath,
      initialFingerprint,
      isCancelled: false,
      cancelReason: null,
      isSwapped: false,
      cancellationPromise: null
    };
    this.activeJob = job;

    const facts = await probeMediaFacts(canonical, {
      onChildProcess: (c) => this._registerProcess(c),
      isCancelled: () => job.isCancelled || this.isPlaybackActive
    });

    if (job.isCancelled || this.isPlaybackActive) {
      return this._handleJobCancellation(job);
    }

    const rule = findRepairCandidate(facts, ext, { allowUncertified: this.allowUncertifiedCandidate });
    if (!rule) {
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'No applicable repair candidate rule' };
    }

    if (!this.allowUncertifiedCandidate && rule.status !== 'CERTIFIED_FOR_TESTED_ENVELOPE') {
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'Uncertified candidate rule blocked by production safety gate' };
    }

    this.journal.recordState(canonical, NormalizationState.PENDING, { ruleId: rule.ruleId, initialFingerprint });

    if (job.isCancelled || this.isPlaybackActive) {
      return this._handleJobCancellation(job);
    }

    this.journal.recordState(canonical, NormalizationState.REMUXING, { partialPath });

    const remuxResult = await new Promise((resolve) => {
      const opArgs = rule.operation?.ffmpegArgs || ['-map', '0', '-c', 'copy', '-tag:v', rule.expectedOutputTag || 'hvc1'];
      const args = ['-v', 'error', '-y', '-i', canonical, ...opArgs, '-f', 'mp4', partialPath];
      const child = (this.spawn || spawn)('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this._registerProcess(child);
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(partialPath)) resolve({ ok: true });
        else resolve({ ok: false, error: stderr.trim() || `ffmpeg exited with code ${code}` });
      });
    });

    if (job.isCancelled || this.isPlaybackActive || !remuxResult.ok) {
      if (job.isCancelled || this.isPlaybackActive) {
        return this._handleJobCancellation(job);
      }
      const rollback = executeRollback({
        canonical,
        oldPath,
        partialPath,
        isSwapped: false,
        initialFingerprint,
        fileOps: this.fileOps
      });
      const err = remuxResult.error || 'Remux execution failed';
      if (!rollback.ok) {
        this.status = EngineStatus.RECOVERY_BLOCKED;
        this.journal.recordState(canonical, NormalizationState.RECOVERY_REQUIRED, {
          error: 'ROLLBACK_FAILED_RECOVERY_REQUIRED',
          originalError: err,
          rollbackError: rollback.error
        });
        this.activeJob = null;
        this.isProcessing = false;
        return { ok: false, state: NormalizationState.RECOVERY_REQUIRED, error: `Remux cleanup failed: ${rollback.error}` };
      }
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: err });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: err };
    }

    this.journal.recordState(canonical, NormalizationState.STRUCTURE_VERIFYING);
    const structVerify = await verifyNormalizedOutput(canonical, partialPath, rule, {
      onChildProcess: (c) => this._registerProcess(c),
      isCancelled: () => job.isCancelled || this.isPlaybackActive
    });

    if (job.isCancelled || this.isPlaybackActive) {
      return this._handleJobCancellation(job);
    }

    if (!structVerify.ok) {
      const rollback = executeRollback({
        canonical,
        oldPath,
        partialPath,
        isSwapped: false,
        initialFingerprint,
        fileOps: this.fileOps
      });
      if (!rollback.ok) {
        this.status = EngineStatus.RECOVERY_BLOCKED;
        this.journal.recordState(canonical, NormalizationState.RECOVERY_REQUIRED, {
          error: 'ROLLBACK_FAILED_RECOVERY_REQUIRED',
          originalError: structVerify.reason,
          rollbackError: rollback.error
        });
        this.activeJob = null;
        this.isProcessing = false;
        return { ok: false, state: NormalizationState.RECOVERY_REQUIRED, error: `Structure verify cleanup failed: ${rollback.error}` };
      }
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: structVerify.reason });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: structVerify.reason };
    }

    this.journal.recordState(canonical, NormalizationState.VERIFIED);

    if (job.isCancelled || this.isPlaybackActive) {
      return this._handleJobCancellation(job);
    }

    if (!isFingerprintValid(canonical, initialFingerprint)) {
      const rollback = executeRollback({
        canonical,
        oldPath,
        partialPath,
        isSwapped: false,
        initialFingerprint,
        fileOps: this.fileOps
      });
      this.journal.recordState(canonical, NormalizationState.RECOVERY_REQUIRED, {
        error: 'ORIGINAL_FINGERPRINT_MISMATCH',
        reason: 'Original source file mutated during remuxing process',
        rollbackError: rollback.ok ? null : rollback.error
      });
      this.status = EngineStatus.RECOVERY_BLOCKED;
      this.activeJob = null;
      this.isProcessing = false;
      return { ok: false, state: NormalizationState.RECOVERY_REQUIRED, error: 'ORIGINAL_FINGERPRINT_MISMATCH' };
    }

    this.journal.recordState(canonical, NormalizationState.SWAP_STEP1_RENAME_ORIGINAL, { oldPath, partialPath, initialFingerprint });

    try {
      (this.fileOps.renameSync || fs.renameSync)(canonical, oldPath);
      job.isSwapped = true;
    } catch (step1Err) {
      const rollback = executeRollback({
        canonical,
        oldPath,
        partialPath,
        isSwapped: false,
        initialFingerprint,
        fileOps: this.fileOps
      });
      if (!rollback.ok) {
        this.status = EngineStatus.RECOVERY_BLOCKED;
        this.journal.recordState(canonical, NormalizationState.RECOVERY_REQUIRED, {
          error: 'ROLLBACK_FAILED_RECOVERY_REQUIRED',
          originalError: step1Err.message,
          rollbackError: rollback.error
        });
        this.activeJob = null;
        this.isProcessing = false;
        return { ok: false, state: NormalizationState.RECOVERY_REQUIRED, error: `Swap step 1 cleanup failed: ${rollback.error}` };
      }
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: `Swap step 1 failed: ${step1Err.message}` });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: step1Err.message };
    }

    this.journal.recordState(canonical, NormalizationState.SWAP_STEP2_RENAME_PARTIAL, { oldPath, canonical, initialFingerprint });

    try {
      (this.fileOps.renameSync || fs.renameSync)(partialPath, canonical);
    } catch (step2Err) {
      const rollback = executeRollback({ canonical, oldPath, partialPath, isSwapped: true, initialFingerprint, fileOps: this.fileOps });
      if (!rollback.ok) {
        this.status = EngineStatus.RECOVERY_BLOCKED;
        this.journal.recordState(canonical, NormalizationState.RECOVERY_REQUIRED, {
          error: 'ROLLBACK_FAILED_RECOVERY_REQUIRED',
          originalError: step2Err.message,
          rollbackError: rollback.error
        });
        return { ok: false, state: NormalizationState.RECOVERY_REQUIRED, error: `Swap step 2 rollback failed: ${rollback.error}` };
      }
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: `Swap step 2 failed: ${step2Err.message}`, rolledBack: true });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: step2Err.message };
    }

    this.journal.recordState(canonical, NormalizationState.FINAL_VERIFYING, { initialFingerprint });
    const finalVerify = await verifyNormalizedOutput(oldPath, canonical, rule, {
      onChildProcess: (c) => this._registerProcess(c),
      isCancelled: () => job.isCancelled || this.isPlaybackActive
    });

    if (job.isCancelled || this.isPlaybackActive) {
      return this._handleJobCancellation(job);
    }

    if (!finalVerify.ok) {
      const rollback = executeRollback({ canonical, oldPath, partialPath, isSwapped: true, initialFingerprint, fileOps: this.fileOps });
      if (!rollback.ok) {
        this.status = EngineStatus.RECOVERY_BLOCKED;
        this.journal.recordState(canonical, NormalizationState.RECOVERY_REQUIRED, {
          error: 'ROLLBACK_FAILED_RECOVERY_REQUIRED',
          originalError: finalVerify.reason,
          rollbackError: rollback.error
        });
        return { ok: false, state: NormalizationState.RECOVERY_REQUIRED, error: `Final verify rollback failed: ${rollback.error}` };
      }
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: `Final verify failed: ${finalVerify.reason}`, rolledBack: true });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: finalVerify.reason };
    }

    const replacementFingerprint = this.getMediaFingerprint(canonical);
    if (!replacementFingerprint || typeof replacementFingerprint.sizeBytes !== 'number' || typeof replacementFingerprint.mtimeMs !== 'number') {
      this.journal.recordState(canonical, NormalizationState.RECOVERY_REQUIRED, {
        error: 'REPLACEMENT_FINGERPRINT_UNAVAILABLE',
        initialFingerprint
      });
      this.status = EngineStatus.RECOVERY_BLOCKED;
      this.activeJob = null;
      this.isProcessing = false;
      return { ok: false, state: NormalizationState.RECOVERY_REQUIRED, error: 'REPLACEMENT_FINGERPRINT_UNAVAILABLE' };
    }

    this.journal.recordState(canonical, NormalizationState.FINAL_VERIFIED, {
      finalVerifiedAt: new Date().toISOString(),
      initialFingerprint,
      replacementFingerprint
    });

    if (this.fileOps.onFinalVerified) {
      await this.fileOps.onFinalVerified(job);
    }

    if (job.isCancelled || this.isPlaybackActive) {
      return this._handleJobCancellation(job);
    }

    const currentReplacementFp = this.getMediaFingerprint(canonical);
    if (!currentReplacementFp || currentReplacementFp.sizeBytes !== replacementFingerprint.sizeBytes || currentReplacementFp.mtimeMs !== replacementFingerprint.mtimeMs) {
      console.error('[NormalizationEngine] Replacement fingerprint mismatch before unlinking old backup. Preserving backup.');
      this.journal.recordState(canonical, NormalizationState.RECOVERY_REQUIRED, {
        error: 'REPLACEMENT_TAMPERED_BEFORE_BACKUP_CLEANUP',
        initialFingerprint,
        replacementFingerprint
      });
      this.status = EngineStatus.RECOVERY_BLOCKED;
      this.activeJob = null;
      this.isProcessing = false;
      return { ok: false, state: NormalizationState.RECOVERY_REQUIRED, error: 'REPLACEMENT_TAMPERED_BEFORE_BACKUP_CLEANUP' };
    }

    let cleanupSuccess = true;
    let cleanupError = null;
    if (fs.existsSync(oldPath)) {
      try {
        (this.fileOps.unlinkSync || fs.unlinkSync)(oldPath);
      } catch (unlinkErr) {
        cleanupSuccess = false;
        cleanupError = unlinkErr.message;
        console.warn(`[NormalizationEngine] Warning: Could not unlink old file: ${unlinkErr.message}`);
      }
    }

    if (!cleanupSuccess) {
      this.journal.recordState(canonical, NormalizationState.CLEANUP_PENDING, {
        finalVerifiedAt: new Date().toISOString(),
        initialFingerprint,
        replacementFingerprint,
        cleanupError
      });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.CLEANUP_PENDING;
      return { ok: false, state: NormalizationState.CLEANUP_PENDING, error: `Old backup cleanup failed: ${cleanupError}` };
    }

    this.journal.recordState(canonical, NormalizationState.DONE, { completedAt: new Date().toISOString() });
    this.activeJob = null;
    this.isProcessing = false;
    this.status = EngineStatus.SAFE_IDLE;
    return { ok: true, state: NormalizationState.DONE };
  }
}
