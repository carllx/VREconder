import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { NormalizationJournal, NormalizationState } from './journal.mjs';
import { getDiskFreeSpace } from './inventory-scanner.mjs';
import { probeMediaFacts } from './ffprobe-facts.mjs';
import { getMediaFingerprint, isFingerprintValid } from './fingerprint.mjs';
import { verifyNormalizedOutput } from './verifier.mjs';
import { findRepairCandidate } from './repair-rules.mjs';

export const EngineStatus = {
  UNINITIALIZED: 'UNINITIALIZED',
  SAFE_IDLE: 'SAFE_IDLE',
  PROCESSING: 'PROCESSING',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  PAUSED_FOR_PLAYBACK: 'PAUSED_FOR_PLAYBACK',
  JOURNAL_CORRUPT: 'JOURNAL_CORRUPT',
  RECOVERY_BLOCKED: 'RECOVERY_BLOCKED'
};

export class NormalizationEngine {
  constructor(options = {}) {
    this.journal = options.journal || new NormalizationJournal(options.journalPath || path.join(process.cwd(), 'prototype/lan_secure_origin/normalization_journal.json'));
    this.executionEnabled = options.executionEnabled ?? false; // Hard safety gate: disabled by default
    this.allowedRoots = options.allowedRoots || null; // Optional isolation guard
    this.status = EngineStatus.UNINITIALIZED;
    this.activeChildProcess = null;
    this.activeJob = null;
    this.isPlaybackActive = false;
    this.concurrency = 1;
    this.isProcessing = false;
    this._childExitPromise = null;
    this._childExitResolver = null;
  }

  /**
   * Initializes engine on startup: validates journal and executes deterministic recovery.
   * 
   * @returns {Promise<{ ok: boolean, status: string, details: object }>}
   */
  async initialize() {
    // 1. Validate journal file integrity
    const validation = this.journal.validateJournal();
    if (!validation.ok) {
      this.status = EngineStatus.JOURNAL_CORRUPT;
      return { ok: false, status: EngineStatus.JOURNAL_CORRUPT, details: { error: validation.error } };
    }

    // 2. Perform deterministic startup recovery scan
    const recovery = this.journal.recoverOnStartup();
    if (!recovery.ok) {
      this.status = EngineStatus.RECOVERY_BLOCKED;
      return { ok: false, status: EngineStatus.RECOVERY_BLOCKED, details: recovery };
    }

    this.status = EngineStatus.SAFE_IDLE;
    return { ok: true, status: EngineStatus.SAFE_IDLE, details: recovery };
  }

  notifyPlaybackState(isActive) {
    this.isPlaybackActive = !!isActive;
    if (this.isPlaybackActive && this.activeJob && !this.activeJob.isCancelled) {
      console.log(`[NormalizationEngine] Playback active! Cancelling active job: ${this.activeJob.originalPath}`);
      this.cancelActiveJobForPlayback();
    }
  }

  /**
   * Monotonic job-level cancellation.
   * Waits asynchronously until child process exits before releasing locks.
   * 
   * @returns {Promise<void>}
   */
  async cancelActiveJobForPlayback() {
    if (!this.activeJob) return;

    this.activeJob.isCancelled = true;
    this.activeJob.cancelReason = 'PLAYBACK_ACTIVE';
    this.status = EngineStatus.CANCEL_REQUESTED;

    if (this.activeChildProcess) {
      try {
        this.activeChildProcess.kill('SIGTERM');
      } catch (_) {}
    }

    if (this._childExitPromise) {
      await this._childExitPromise;
    }

    const { partialPath, originalPath } = this.activeJob;
    if (fs.existsSync(partialPath)) {
      try { fs.unlinkSync(partialPath); } catch (_) {}
    }

    try {
      this.journal.recordState(originalPath, NormalizationState.PAUSED_FOR_PLAYBACK, {
        reason: 'Active playback initiated',
        pausedAt: new Date().toISOString()
      });
    } catch (_) {}

    this.activeJob = null;
    this.isProcessing = false;
    this.status = EngineStatus.PAUSED_FOR_PLAYBACK;
  }

  /**
   * Executes in-place normalization for a single candidate file.
   * 
   * @param {string} originalPath 
   * @returns {Promise<{ ok: boolean, state: string, error?: string }>}
   */
  async processCandidate(originalPath) {
    if (this.status === EngineStatus.JOURNAL_CORRUPT || this.status === EngineStatus.RECOVERY_BLOCKED) {
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

    if (this.isProcessing || this.activeChildProcess) {
      return {
        ok: false,
        state: NormalizationState.FAILED_SAFE,
        error: 'Concurrency limit (1) exceeded or previous child process still exiting'
      };
    }

    this.isProcessing = true;
    this.status = EngineStatus.PROCESSING;

    const canonical = path.normalize(path.resolve(originalPath));

    // Path guard check
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

    // P0 Safety: Pre-existing recovery artifacts must NEVER be blindly unlinked
    if (fs.existsSync(oldPath) || fs.existsSync(partialPath)) {
      let entry = null;
      try {
        entry = this.journal.getEntry(canonical);
      } catch (e) {
        this.isProcessing = false;
        this.status = EngineStatus.JOURNAL_CORRUPT;
        return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'JOURNAL_CORRUPT' };
      }

      // If journal has no proven active record for this target, FAIL CLOSED
      if (!entry || (entry.currentState === NormalizationState.DONE || entry.currentState === NormalizationState.FAILED_SAFE)) {
        this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, {
          error: 'BLOCKED_RECOVERY_REQUIRED',
          reason: 'Pre-existing .vreconder-old or .partial artifact found without valid pending journal state'
        });
        this.isProcessing = false;
        this.status = EngineStatus.SAFE_IDLE;
        return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'BLOCKED_RECOVERY_REQUIRED' };
      }
    }

    // P0 Safety: Free space UNKNOWN must fail closed
    const stat = fs.statSync(canonical);
    const requiredFree = Math.ceil(stat.size * 1.2);
    const available = getDiskFreeSpace(canonical);

    if (available < 0) {
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, {
        error: 'BLOCKED_SPACE_UNKNOWN',
        available
      });
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'BLOCKED_SPACE_UNKNOWN' };
    }

    if (available < requiredFree) {
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, {
        error: 'BLOCKED_NO_SPACE',
        requiredFree,
        available
      });
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'BLOCKED_NO_SPACE' };
    }

    // Probing facts and matching certified rule
    const facts = await probeMediaFacts(canonical);
    const rule = findRepairCandidate(facts, ext);
    if (!rule) {
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'No applicable repair candidate rule' };
    }

    // Capture initial fingerprint for invariant comparison
    const initialFingerprint = getMediaFingerprint(canonical);

    // Initialize Job Descriptor with Monotonic Cancellation State
    const job = {
      originalPath: canonical,
      partialPath,
      oldPath,
      initialFingerprint,
      isCancelled: false,
      cancelReason: null
    };
    this.activeJob = job;

    // Phase 1: PENDING
    this.journal.recordState(canonical, NormalizationState.PENDING, {
      ruleId: rule.ruleId,
      initialFingerprint
    });

    if (job.isCancelled || this.isPlaybackActive) {
      return this._handleJobCancellation(job);
    }

    // Phase 2: REMUXING
    this.journal.recordState(canonical, NormalizationState.REMUXING, { partialPath });

    const remuxResult = await new Promise((resolve) => {
      const args = [
        '-v', 'error',
        '-y',
        '-i', canonical,
        '-map', '0',
        '-c', 'copy',
        '-tag:v', rule.expectedOutputTag || 'hvc1',
        '-f', 'mp4',
        partialPath
      ];

      this._childExitPromise = new Promise(r => { this._childExitResolver = r; });
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.activeChildProcess = child;
      let stderr = '';

      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => {
        this.activeChildProcess = null;
        if (this._childExitResolver) this._childExitResolver();
        resolve({ ok: false, error: err.message });
      });
      child.on('close', (code) => {
        this.activeChildProcess = null;
        if (this._childExitResolver) this._childExitResolver();
        if (code === 0 && fs.existsSync(partialPath)) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: stderr.trim() || `ffmpeg exited with code ${code}` });
        }
      });
    });

    if (job.isCancelled || this.isPlaybackActive || !remuxResult.ok) {
      if (fs.existsSync(partialPath)) {
        try { fs.unlinkSync(partialPath); } catch (_) {}
      }
      const err = remuxResult.ok ? 'Cancelled for playback' : remuxResult.error;
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: err });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: err };
    }

    // Phase 3: STRUCTURE_VERIFYING
    this.journal.recordState(canonical, NormalizationState.STRUCTURE_VERIFYING);
    const structVerify = await verifyNormalizedOutput(canonical, partialPath, rule);
    if (!structVerify.ok) {
      if (fs.existsSync(partialPath)) {
        try { fs.unlinkSync(partialPath); } catch (_) {}
      }
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: structVerify.reason });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: structVerify.reason };
    }

    // Phase 4: VERIFIED
    this.journal.recordState(canonical, NormalizationState.VERIFIED);

    // Monotonic cancellation check & playback check IMMEDIATELY before swap
    if (job.isCancelled || this.isPlaybackActive) {
      return this._handleJobCancellation(job);
    }

    // Invariant check: Original fingerprint must be identical to when job started
    if (!isFingerprintValid(canonical, initialFingerprint)) {
      if (fs.existsSync(partialPath)) try { fs.unlinkSync(partialPath); } catch (_) {}
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, {
        error: 'ORIGINAL_FINGERPRINT_MISMATCH',
        reason: 'Original source file mutated during remuxing process'
      });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: 'ORIGINAL_FINGERPRINT_MISMATCH' };
    }

    // Phase 5: Transactional Step 1 — Rename canonical -> oldPath
    this.journal.recordState(canonical, NormalizationState.SWAP_STEP1_RENAME_ORIGINAL, {
      oldPath,
      partialPath,
      initialFingerprint
    });

    try {
      fs.renameSync(canonical, oldPath);
    } catch (step1Err) {
      if (fs.existsSync(partialPath)) try { fs.unlinkSync(partialPath); } catch (_) {}
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: `Swap step 1 failed: ${step1Err.message}` });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: step1Err.message };
    }

    // Phase 6: Transactional Step 2 — Rename partialPath -> canonical
    this.journal.recordState(canonical, NormalizationState.SWAP_STEP2_RENAME_PARTIAL, {
      oldPath,
      canonical
    });

    try {
      fs.renameSync(partialPath, canonical);
    } catch (step2Err) {
      // Emergency Rollback: restore oldPath back to canonical
      if (fs.existsSync(oldPath) && !fs.existsSync(canonical)) {
        try { fs.renameSync(oldPath, canonical); } catch (_) {}
      }
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: `Swap step 2 failed: ${step2Err.message}` });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: step2Err.message };
    }

    // Phase 7: FINAL_VERIFYING on the newly installed canonical file
    this.journal.recordState(canonical, NormalizationState.FINAL_VERIFYING);
    const finalVerify = await verifyNormalizedOutput(oldPath, canonical, rule);
    if (!finalVerify.ok) {
      // Deterministic Emergency Rollback: remove corrupt target and restore verified original
      try {
        if (fs.existsSync(canonical)) fs.unlinkSync(canonical);
        fs.renameSync(oldPath, canonical);
      } catch (_) {}
      this.journal.recordState(canonical, NormalizationState.FAILED_SAFE, { error: `Final verify failed: ${finalVerify.reason}` });
      this.activeJob = null;
      this.isProcessing = false;
      this.status = EngineStatus.SAFE_IDLE;
      return { ok: false, state: NormalizationState.FAILED_SAFE, error: finalVerify.reason };
    }

    // Phase 8: DONE — Only now is old file unlinked
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
    this.status = EngineStatus.SAFE_IDLE;
    return { ok: true, state: NormalizationState.DONE };
  }

  _handleJobCancellation(job) {
    if (fs.existsSync(job.partialPath)) {
      try { fs.unlinkSync(job.partialPath); } catch (_) {}
    }
    this.journal.recordState(job.originalPath, NormalizationState.PAUSED_FOR_PLAYBACK, {
      reason: job.cancelReason || 'Active playback priority',
      pausedAt: new Date().toISOString()
    });
    this.activeJob = null;
    this.isProcessing = false;
    this.status = EngineStatus.PAUSED_FOR_PLAYBACK;
    return { ok: false, state: NormalizationState.PAUSED_FOR_PLAYBACK, error: 'Cancelled for playback' };
  }
}

