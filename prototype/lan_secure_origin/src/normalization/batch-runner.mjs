import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { NormalizationEngine, EngineStatus } from './normalization-engine.mjs';
import { NormalizationJournal, NormalizationState } from './journal.mjs';
import { probeMediaFacts } from './ffprobe-facts.mjs';
import { classifyMedia, isDerivativeFile, MediaClass } from './classification.mjs';
import { findRepairCandidate, matchNormalizedCertifiedBucket } from './repair-rules.mjs';
import { evaluateDiskFreeSpaceSafety } from './inventory-scanner.mjs';
import { verifyAuthorizationUniverse } from './authorization-manifest.mjs';

export const CANONICAL_ACCEPTED_INVENTORY = 'scanned_raw_library.json';

export const BatchStatus = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED_FOR_PLAYBACK: 'PAUSED_FOR_PLAYBACK',
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED'
};

/**
 * Authoritative Server Playback Monitor.
 * Subscribes via SSE to the running media server and polls playback status
 * to ensure playback-active priority yields are respected across processes.
 * Fails closed if the signal is unavailable, invalid, disconnected, or stale.
 */
export class ServerPlaybackMonitor {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || 'http://127.0.0.1:8080';
    this.pollIntervalMs = options.pollIntervalMs || 500;
    this.freshnessTimeoutMs = options.freshnessTimeoutMs || 3000;
    this.isPlaybackActive = false;
    this.isHealthy = false;
    this.healthReason = 'UNINITIALIZED';
    this.lastHealthyAt = 0;
    this.listeners = new Set();
    this.pollTimer = null;
    this.sseReq = null;
    this.isClosed = false;
  }

  async checkHealth() {
    return new Promise((resolve) => {
      try {
        const url = new URL('/api/playback/status', this.serverUrl);
        const req = http.get(url, { timeout: 2000 }, (res) => {
          if (res.statusCode !== 200) {
            this.isHealthy = false;
            this.healthReason = `HTTP_STATUS_${res.statusCode}`;
            res.resume();
            return resolve({ ok: false, reason: this.healthReason });
          }
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              if (typeof parsed.isPlaybackActive !== 'boolean') {
                this.isHealthy = false;
                this.healthReason = 'INVALID_PLAYBACK_RESPONSE_PAYLOAD';
                return resolve({ ok: false, reason: this.healthReason });
              }
              this.isHealthy = true;
              this.healthReason = 'HEALTHY';
              this.lastHealthyAt = Date.now();
              this._updateState(parsed.isPlaybackActive);
              return resolve({ ok: true, isPlaybackActive: this.isPlaybackActive });
            } catch (err) {
              this.isHealthy = false;
              this.healthReason = `JSON_PARSE_ERROR: ${err.message}`;
              return resolve({ ok: false, reason: this.healthReason });
            }
          });
        });
        req.on('timeout', () => { req.destroy(); this.isHealthy = false; this.healthReason = 'SERVER_TIMEOUT'; resolve({ ok: false, reason: this.healthReason }); });
        req.on('error', (err) => { this.isHealthy = false; this.healthReason = `SERVER_UNAVAILABLE: ${err.message}`; resolve({ ok: false, reason: this.healthReason }); });
      } catch (e) {
        this.isHealthy = false;
        this.healthReason = `INVALID_URL: ${e.message}`;
        resolve({ ok: false, reason: this.healthReason });
      }
    });
  }

  isSignalHealthy() {
    return this.isHealthy && this.lastHealthyAt > 0 && (Date.now() - this.lastHealthyAt) <= this.freshnessTimeoutMs;
  }

  start() {
    this._connectSse();
    this._startPolling();
    return this;
  }

  _connectSse() {
    if (this.isClosed) return;
    try {
      const url = new URL('/api/playback/events', this.serverUrl);
      this.sseReq = http.get(url, (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data:')) {
              try {
                const data = JSON.parse(line.slice(5).trim());
                if (typeof data.isPlaybackActive === 'boolean') {
                  this.isHealthy = true;
                  this.healthReason = 'HEALTHY';
                  this.lastHealthyAt = Date.now();
                  this._updateState(data.isPlaybackActive);
                }
              } catch (_) {}
            }
          }
        });
        res.on('close', () => { if (!this.isClosed) { this.isHealthy = false; this.healthReason = 'SSE_DISCONNECTED'; setTimeout(() => this._connectSse(), 1000); } });
      });
      this.sseReq.on('error', () => { if (!this.isClosed) { this.isHealthy = false; this.healthReason = 'SSE_ERROR'; setTimeout(() => this._connectSse(), 2000); } });
    } catch (_) {}
  }

  _startPolling() {
    if (this.isClosed) return;
    this.pollTimer = setInterval(async () => {
      if (this.isClosed) return;
      await this.checkHealth();
    }, this.pollIntervalMs);
  }

  _updateState(nextState) {
    if (this.isPlaybackActive !== nextState) {
      this.isPlaybackActive = nextState;
      for (const fn of this.listeners) {
        try { fn(nextState); } catch (_) {}
      }
    }
  }

  onActiveChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.isClosed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.sseReq) {
      try { this.sseReq.destroy(); } catch (_) {}
      this.sseReq = null;
    }
    this.listeners.clear();
  }
}

/**
 * Derives the active pending candidate queue from accepted inventory,
 * excluding already-DONE items and items that no longer match candidate rules.
 * 
 * @param {object} options
 * @returns {Promise<{ totalAcceptedUniverse: number, alreadyCompleted: Array, pendingQueue: Array, skippedOrExcluded: Array }>}
 */
export async function derivePendingQueue(options = {}) {
  const { inventoryPath, inventoryItems, journal, probeFacts = probeMediaFacts, fileOps = {} } = options;
  let items = inventoryItems || [];

  if (!items.length && inventoryPath && fs.existsSync(inventoryPath)) {
    try {
      items = JSON.parse((fileOps.readFileSync || fs.readFileSync)(inventoryPath, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to read inventory file at ${inventoryPath}: ${e.message}`);
    }
  }

  const pendingQueue = [];
  const alreadyCompleted = [];
  const skippedOrExcluded = [];
  let totalAcceptedUniverse = 0;

  const candidatesToCheck = [];
  for (const item of items) {
    const fullPath = item.fullPath || item.path;
    if (!fullPath) continue;

    if (item.isDerivative || isDerivativeFile(fullPath)) {
      skippedOrExcluded.push({ path: fullPath, reason: 'DERIVATIVE_FILE' });
      continue;
    }

    // 1. Initial inventory classification check
    const initialFacts = item.facts || null;
    const initialClass = item.classification || (initialFacts ? classifyMedia(fullPath, initialFacts).classification : null);

    // Strict scope gate: ONLY accept EXACT_CERTIFIED_NORMALIZATION_CANDIDATE
    if (initialClass !== MediaClass.EXACT_CERTIFIED_NORMALIZATION_CANDIDATE) {
      skippedOrExcluded.push({ path: fullPath, reason: `NON_CERTIFIED_CLASS_${initialClass}` });
      continue;
    }

    totalAcceptedUniverse++;

    // 2. Authoritative Journal check (e.g. Pilot media is already DONE)
    if (journal) {
      try {
        const entry = journal.getEntry(fullPath);
        if (entry && entry.currentState === NormalizationState.DONE) {
          alreadyCompleted.push({ path: fullPath, reason: 'JOURNAL_ALREADY_DONE' });
          continue;
        }
      } catch (_) {}
    }

    candidatesToCheck.push(item);
  }

  // 3. Current Disk Facts check with bounded concurrency (8)
  const probeConcurrency = options.concurrency || 8;
  const queue = [...candidatesToCheck];
  async function probeWorker() {
    while (queue.length > 0) {
      const item = queue.shift();
      const fullPath = item.fullPath || item.path;
      const existsFn = fileOps.existsSync || fs.existsSync;
      if (!existsFn(fullPath)) {
        skippedOrExcluded.push({ path: fullPath, reason: 'FILE_NOT_FOUND_ON_DISK' });
        continue;
      }

      try {
        const currentFacts = await probeFacts(fullPath);
        const ext = path.extname(fullPath);
        const rule = findRepairCandidate(currentFacts, ext);

        if (!rule) {
          const normBucket = matchNormalizedCertifiedBucket(currentFacts, ext);
          if (normBucket) {
            alreadyCompleted.push({ path: fullPath, reason: 'CURRENT_FACTS_ALREADY_NORMALIZED', matchedBucket: normBucket.bucketId });
          } else {
            skippedOrExcluded.push({ path: fullPath, reason: 'CURRENT_FACTS_DRIFT_EXCLUDED' });
          }
          continue;
        }

        pendingQueue.push({
          fullPath,
          sizeBytes: item.sizeBytes || (fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0),
          ruleId: rule.ruleId,
          matchedBucket: rule.matchedBucket?.bucketId || null
        });
      } catch (probeErr) {
        skippedOrExcluded.push({ path: fullPath, reason: `PROBE_FAILED: ${probeErr.message}` });
      }
    }
  }

  const workers = Array.from({ length: Math.min(probeConcurrency, candidatesToCheck.length || 1) }, () => probeWorker());
  await Promise.all(workers);

  return {
    totalAcceptedUniverse,
    alreadyCompleted,
    pendingQueue,
    skippedOrExcluded
  };
}

/**
 * Lightweight, recoverable Batch Normalization Queue Controller.
 */
export class BatchNormalizationRunner {
  constructor(options = {}) {
    this.journal = options.journal || new NormalizationJournal(options.journalPath || path.join(process.cwd(), 'prototype/lan_secure_origin/normalization_journal.json'));
    this.executionEnabled = options.executionEnabled ?? false; // Strict safety gate: default disabled
    this.allowedRoots = options.allowedRoots || null;
    this.fileOps = options.fileOps || {};
    this.playbackMonitor = options.playbackMonitor || null;
    this.onProgress = options.onProgress || null;

    this.verifyAuthorizationManifest = options.verifyAuthorizationManifest ?? false;
    this.manifestPath = options.manifestPath || null;
    this.inventoryPath = options.inventoryPath || null;

    // Scope lock: In destructive mode, forbid custom inventory override
    if (this.executionEnabled && options.inventoryPath) {
      const base = path.basename(options.inventoryPath);
      if (base !== CANONICAL_ACCEPTED_INVENTORY) {
        this.status = BatchStatus.BLOCKED;
        this.isBlocked = true;
        this.blockReason = `DESTRUCTIVE_AUTHORIZATION_SCOPE_VIOLATION: Custom inventory override prohibited in destructive mode. Must use ${CANONICAL_ACCEPTED_INVENTORY}`;
        throw new Error(this.blockReason);
      }
    }

    this.engine = options.engine || new NormalizationEngine({
      journal: this.journal,
      executionEnabled: this.executionEnabled,
      allowedRoots: this.allowedRoots,
      fileOps: this.fileOps
    });

    this.status = BatchStatus.IDLE;
    this.isBlocked = false;
    this.blockReason = null;
    this.activeJobPath = null;
    this.completedItems = [];
    this.failedSafeItems = [];
    this.pendingQueue = [];
    this.totalCandidates = 0;
    this.isStopped = false;

    // Hook playback monitor if provided
    if (this.playbackMonitor && typeof this.playbackMonitor.onActiveChange === 'function') {
      this.playbackMonitor.onActiveChange((isActive) => {
        this.notifyPlaybackState(isActive);
      });
    }
  }

  notifyPlaybackState(isActive) {
    this.engine.notifyPlaybackState(isActive);
    if (isActive) {
      this.status = BatchStatus.PAUSED_FOR_PLAYBACK;
      this._emitProgress();
    }
  }

  getProgress() {
    return {
      total: this.totalCandidates,
      completed: this.completedItems.length,
      remaining: this.pendingQueue.length,
      failedSafe: this.failedSafeItems.length,
      blocked: this.isBlocked,
      blockReason: this.blockReason,
      current: this.activeJobPath ? path.basename(this.activeJobPath) : null,
      status: this.status
    };
  }

  formatProgress(progress = this.getProgress()) {
    return [
      `Total: ${progress.total}`,
      `Completed: ${progress.completed}`,
      `Remaining: ${progress.remaining}`,
      `Failed Safe: ${progress.failedSafe}`,
      `Blocked: ${progress.blocked ? `yes (${progress.blockReason || 'UNKNOWN'})` : 'no'}`,
      `Current: ${progress.current || '--'}`
    ].join('\n');
  }

  _emitProgress() {
    const prog = this.getProgress();
    if (typeof this.onProgress === 'function') {
      try { this.onProgress(prog, this.formatProgress(prog)); } catch (_) {}
    }
  }

  async _waitForPlaybackToClear(checkIntervalMs = 100) {
    while (this.engine.isPlaybackActive || (this.playbackMonitor && this.playbackMonitor.isPlaybackActive)) {
      if (this.isStopped) break;
      await new Promise(r => setTimeout(r, checkIntervalMs));
    }
  }

  stop() {
    this.isStopped = true;
  }

  /**
   * Executes the batch queue sequentially with concurrency = 1.
   * 
   * @param {Array<object|string>} candidateQueue 
   * @param {object} [options]
   * @returns {Promise<object>} Batch execution report
   */
  async runQueue(candidateQueue, options = {}) {
    if (this.status === BatchStatus.RUNNING) {
      throw new Error('Batch runner is already executing.');
    }

    this.pendingQueue = candidateQueue.map(c => typeof c === 'string' ? { fullPath: c } : c);
    const initialCompleted = options.alreadyCompleted || [];
    this.completedItems = [...initialCompleted];
    this.failedSafeItems = [];
    this.totalCandidates = this.pendingQueue.length + this.completedItems.length;
    this.status = BatchStatus.RUNNING;
    this.isBlocked = false;
    this.blockReason = null;
    this._emitProgress();

    // -1. Authorization universe identity lock verification in destructive mode
    if (this.executionEnabled && this.verifyAuthorizationManifest) {
      const authCheck = verifyAuthorizationUniverse({
        manifestPath: options.manifestPath || this.manifestPath,
        inventoryPath: options.inventoryPath || this.inventoryPath,
        fileOps: this.fileOps
      });
      if (!authCheck.ok) {
        this.status = BatchStatus.BLOCKED;
        this.isBlocked = true;
        this.blockReason = `AUTHORIZATION_UNIVERSE_LOCK_FAILED: ${authCheck.reason}`;
        this._emitProgress();
        return this._generateReport();
      }
    }

    // 0. Playback monitor initial health check (fail-closed if monitor exists but is unhealthy)
    if (this.playbackMonitor && typeof this.playbackMonitor.checkHealth === 'function') {
      const initialHealth = await this.playbackMonitor.checkHealth();
      if (!initialHealth.ok) {
        this.status = BatchStatus.BLOCKED;
        this.isBlocked = true;
        this.blockReason = `PLAYBACK_SIGNAL_UNHEALTHY: ${initialHealth.reason}`;
        this._emitProgress();
        return this._generateReport();
      }
    }

    // 1. Initial health and journal integrity check
    const journalValidation = this.journal.validateJournal();
    if (!journalValidation.ok) {
      this.status = BatchStatus.BLOCKED;
      this.isBlocked = true;
      this.blockReason = `JOURNAL_CORRUPT: ${journalValidation.error}`;
      this._emitProgress();
      return this._generateReport();
    }

    // 2. Engine startup recovery
    const initResult = await this.engine.initialize();
    if (!initResult.ok || this.engine.status !== EngineStatus.SAFE_IDLE) {
      this.status = BatchStatus.BLOCKED;
      this.isBlocked = true;
      this.blockReason = `ENGINE_INIT_FAILED: ${initResult.status}`;
      this._emitProgress();
      return this._generateReport();
    }

    // 3. Sequential Execution Loop (Concurrency = 1)
    while (this.pendingQueue.length > 0 && !this.isBlocked && !this.isStopped) {
      // Playback health check before starting a candidate
      if (this.playbackMonitor) {
        if (typeof this.playbackMonitor.isSignalHealthy === 'function' && !this.playbackMonitor.isSignalHealthy()) {
          const recheck = await this.playbackMonitor.checkHealth();
          if (!recheck.ok) {
            console.error(`[BatchNormalizationRunner] FATAL: Playback signal unhealthy: ${recheck.reason}`);
            this.status = BatchStatus.BLOCKED;
            this.isBlocked = true;
            this.blockReason = `PLAYBACK_SIGNAL_UNHEALTHY: ${recheck.reason}`;
            this.activeJobPath = null;
            this._emitProgress();
            break;
          }
        }
      }

      // Playback yield gate before starting a candidate
      if (this.engine.isPlaybackActive || (this.playbackMonitor && this.playbackMonitor.isPlaybackActive)) {
        this.status = BatchStatus.PAUSED_FOR_PLAYBACK;
        this._emitProgress();
        await this._waitForPlaybackToClear();
        if (this.isStopped || this.isBlocked) break;
        this.status = BatchStatus.RUNNING;
        this._emitProgress();
      }

      const item = this.pendingQueue[0];
      const targetPath = item.fullPath;
      this.activeJobPath = targetPath;
      this._emitProgress();

      // Destructive Free-Space Gate: fail-closed per item
      const spaceCheck = evaluateDiskFreeSpaceSafety(targetPath, { fileOps: this.fileOps });
      if (!spaceCheck.ok) {
        console.error(`[BatchNormalizationRunner] FATAL: Free space gate failed for ${targetPath}: ${spaceCheck.reason}`);
        this.status = BatchStatus.BLOCKED;
        this.isBlocked = true;
        this.blockReason = `DISK_SPACE_GATE_STOPPED: ${spaceCheck.reason}`;
        this.activeJobPath = null;
        this._emitProgress();
        break;
      }

      // Re-verify current journal state before mutation
      const entry = this.journal.getEntry(targetPath);
      if (entry && entry.currentState === NormalizationState.DONE) {
        this.pendingQueue.shift();
        this.completedItems.push(item);
        this.activeJobPath = null;
        this._emitProgress();
        continue;
      }

      // Execute single-file normalization transaction
      let txResult = null;
      try {
        txResult = await this.engine.processCandidate(targetPath);
      } catch (unhandledErr) {
        console.error(`[BatchNormalizationRunner] FATAL: Unhandled exception during processCandidate: ${unhandledErr.message}`);
        this.status = BatchStatus.BLOCKED;
        this.isBlocked = true;
        this.blockReason = `UNHANDLED_EXCEPTION: ${unhandledErr.message}`;
        this.activeJobPath = null;
        this._emitProgress();
        break;
      }

      if (txResult.ok && txResult.state === NormalizationState.DONE) {
        // Individual SUCCESS
        this.pendingQueue.shift();
        this.completedItems.push(item);
        this.activeJobPath = null;
        this._emitProgress();
      } else if (txResult.state === NormalizationState.PAUSED_FOR_PLAYBACK) {
        // Playback Interruption: Do NOT remove from pendingQueue. Yield & retry.
        console.log(`[BatchNormalizationRunner] Transaction paused for active playback: ${targetPath}`);
        this.status = BatchStatus.PAUSED_FOR_PLAYBACK;
        this._emitProgress();
        await this._waitForPlaybackToClear();
        this.activeJobPath = null;
        if (this.isStopped) break;
        this.status = BatchStatus.RUNNING;
        this._emitProgress();
      } else if (txResult.state === NormalizationState.FAILED_SAFE) {
        // Individual Safe Failure: engine confirmed safe idle, isolate and proceed
        if (this.engine.status === EngineStatus.SAFE_IDLE) {
          console.warn(`[BatchNormalizationRunner] Individual safe failure for ${targetPath}: ${txResult.error}`);
          this.pendingQueue.shift();
          this.failedSafeItems.push({
            path: targetPath,
            error: txResult.error,
            failedAt: new Date().toISOString()
          });
          this.activeJobPath = null;
          this._emitProgress();
        } else {
          // Engine left in unhealthy status
          this.status = BatchStatus.BLOCKED;
          this.isBlocked = true;
          this.blockReason = `ENGINE_UNHEALTHY_STATUS: ${this.engine.status}`;
          this.activeJobPath = null;
          this._emitProgress();
          break;
        }
      } else {
        // Queue-Stopping Anomaly (RECOVERY_REQUIRED, RECOVERY_BLOCKED, etc.)
        console.error(`[BatchNormalizationRunner] FATAL: Queue-stopping anomaly for ${targetPath}: ${txResult.error}`);
        this.status = BatchStatus.BLOCKED;
        this.isBlocked = true;
        this.blockReason = `QUEUE_STOPPING_ANOMALY: ${txResult.state || 'UNKNOWN'} (${txResult.error || '--'})`;
        this.activeJobPath = null;
        this._emitProgress();
        break;
      }
    }

    if (!this.isBlocked && this.pendingQueue.length === 0) {
      this.status = BatchStatus.COMPLETED;
    }
    this.activeJobPath = null;
    this._emitProgress();
    return this._generateReport();
  }

  _generateReport() {
    return {
      status: this.status,
      blocked: this.isBlocked,
      blockReason: this.blockReason,
      total: this.totalCandidates,
      completedCount: this.completedItems.length,
      remainingCount: this.pendingQueue.length,
      failedSafeCount: this.failedSafeItems.length,
      completedItems: this.completedItems,
      failedSafeItems: this.failedSafeItems,
      remainingItems: this.pendingQueue
    };
  }
}
