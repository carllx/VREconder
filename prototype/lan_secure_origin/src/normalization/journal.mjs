import fs from 'node:fs';
import path from 'node:path';

export const NormalizationState = {
  PENDING: 'PENDING',
  REMUXING: 'REMUXING',
  STRUCTURE_VERIFYING: 'STRUCTURE_VERIFYING',
  VERIFIED: 'VERIFIED',
  SWAP_STEP1_RENAME_ORIGINAL: 'SWAP_STEP1_RENAME_ORIGINAL',
  SWAP_STEP2_RENAME_PARTIAL: 'SWAP_STEP2_RENAME_PARTIAL',
  FINAL_VERIFYING: 'FINAL_VERIFYING',
  FINAL_VERIFIED: 'FINAL_VERIFIED',
  DONE: 'DONE',
  FAILED_SAFE: 'FAILED_SAFE',
  PAUSED_FOR_PLAYBACK: 'PAUSED_FOR_PLAYBACK',
  CANCELLED: 'CANCELLED'
};

export class NormalizationJournal {
  constructor(journalFilePath) {
    this.journalFilePath = path.resolve(journalFilePath);
    this.isCorrupt = false;
    this.corruptReason = null;
    this.ensureJournalFile();
  }

  ensureJournalFile() {
    const dir = path.dirname(this.journalFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.journalFilePath)) {
      try {
        fs.writeFileSync(this.journalFilePath, JSON.stringify({ version: 1, entries: {} }, null, 2), 'utf8');
      } catch (e) {
        this.isCorrupt = true;
        this.corruptReason = `Failed to create journal file: ${e.message}`;
      }
    }
  }

  readJournal() {
    if (this.isCorrupt) {
      throw new Error(`JOURNAL_CORRUPT: ${this.corruptReason}`);
    }

    if (!fs.existsSync(this.journalFilePath)) {
      this.ensureJournalFile();
    }

    try {
      const content = fs.readFileSync(this.journalFilePath, 'utf8');
      if (!content.trim()) {
        this.isCorrupt = true;
        this.corruptReason = 'Journal file is empty / zero bytes';
        throw new Error(`JOURNAL_CORRUPT: ${this.corruptReason}`);
      }

      const parsed = JSON.parse(content);
      if (!parsed || parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
        this.isCorrupt = true;
        this.corruptReason = `Invalid journal schema or unsupported version: ${parsed?.version}`;
        throw new Error(`JOURNAL_CORRUPT: ${this.corruptReason}`);
      }

      return parsed;
    } catch (e) {
      this.isCorrupt = true;
      this.corruptReason = this.corruptReason || `Malformed JSON in journal file: ${e.message}`;
      throw new Error(`JOURNAL_CORRUPT: ${this.corruptReason}`);
    }
  }

  writeJournal(data) {
    if (this.isCorrupt) {
      throw new Error(`Cannot write to corrupted journal: ${this.corruptReason}`);
    }
    const tmp = `${this.journalFilePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.journalFilePath);
  }

  validateJournal() {
    try {
      this.readJournal();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  getEntry(originalPath) {
    const canonical = path.normalize(path.resolve(originalPath));
    const journal = this.readJournal();
    return journal.entries[canonical] || null;
  }

  recordState(originalPath, state, meta = {}) {
    const canonical = path.normalize(path.resolve(originalPath));
    const journal = this.readJournal();
    const now = new Date().toISOString();

    const existing = journal.entries[canonical] || {
      originalPath: canonical,
      initialFingerprint: meta.initialFingerprint || null,
      history: []
    };

    if (meta.initialFingerprint && !existing.initialFingerprint) {
      existing.initialFingerprint = meta.initialFingerprint;
    }

    existing.currentState = state;
    existing.lastUpdated = now;
    existing.meta = { ...(existing.meta || {}), ...meta };
    existing.history.push({ state, timestamp: now, meta });

    journal.entries[canonical] = existing;
    this.writeJournal(journal);
    return existing;
  }

  /**
   * Deterministic crash recovery on startup.
   * Restores interrupted swaps, cleans up journal-verified orphans, and fails closed on unverified artifacts.
   */
  recoverOnStartup() {
    let journal;
    try {
      journal = this.readJournal();
    } catch (err) {
      return {
        ok: false,
        status: 'JOURNAL_CORRUPT',
        error: err.message,
        actions: [],
        unrecovered: ['JOURNAL_UNREADABLE']
      };
    }

    const actions = [];
    const unrecovered = [];

    for (const [canonical, entry] of Object.entries(journal.entries)) {
      const state = entry.currentState;
      if (state === NormalizationState.DONE || state === NormalizationState.FAILED_SAFE || state === NormalizationState.CANCELLED) {
        continue;
      }

      const dir = path.dirname(canonical);
      const ext = path.extname(canonical);
      const base = path.basename(canonical, ext);
      const partialPath = path.join(dir, `.${base}${ext}.vreconder.partial`);
      const oldPath = path.join(dir, `.${base}${ext}.vreconder-old`);
      const recordedFingerprint = entry.initialFingerprint || entry.meta?.initialFingerprint || null;

      let action = 'none';
      let recovered = true;

      // Crash Case E/F: FINAL_VERIFIED (Final verification succeeded durably before crash, but old file cleanup or DONE was interrupted)
      if (state === NormalizationState.FINAL_VERIFIED) {
        if (fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
            action = 'finalized_verified_canonical_cleaned_old';
          } catch (e) {
            action = `failed_cleanup_old: ${e.message}`;
            recovered = false;
          }
        } else {
          action = 'finalized_verified_canonical_intact';
        }
        if (recovered) {
          this.recordState(canonical, NormalizationState.DONE, {
            completedAt: new Date().toISOString(),
            recoveredFrom: NormalizationState.FINAL_VERIFIED
          });
          actions.push({ originalPath: canonical, action, recovered, stateBeforeRecovery: state });
          continue;
        }
      }
      // Crash Case B/C/D: Interrupted after Step 1, Step 2, or during FINAL_VERIFYING
      else if (
        state === NormalizationState.SWAP_STEP1_RENAME_ORIGINAL ||
        state === NormalizationState.SWAP_STEP2_RENAME_PARTIAL ||
        state === NormalizationState.FINAL_VERIFYING
      ) {
        if (fs.existsSync(oldPath)) {
          // P0-4: Must verify that .old is genuinely the recorded original before any rollback
          let identityMatches = false;
          if (recordedFingerprint) {
            try {
              const oldStat = fs.statSync(oldPath);
              if (oldStat.size === recordedFingerprint.sizeBytes && Math.floor(oldStat.mtimeMs) === recordedFingerprint.mtimeMs) {
                identityMatches = true;
              }
            } catch (_) {
              identityMatches = false;
            }
          }

          if (!identityMatches) {
            action = 'artifact_fingerprint_mismatch_recovery_blocked';
            recovered = false;
          } else {
            // Identity verified: safe to rollback
            try {
              if (fs.existsSync(canonical)) {
                fs.unlinkSync(canonical);
              }
              fs.renameSync(oldPath, canonical);
              action = 'rolled_back_to_proven_original';
            } catch (e) {
              action = `failed_rollback: ${e.message}`;
              recovered = false;
            }
            if (fs.existsSync(partialPath)) {
              try { fs.unlinkSync(partialPath); } catch (_) {}
            }
          }
        } else if (!fs.existsSync(oldPath) && fs.existsSync(canonical)) {
          // Step 1 crash before rename succeeded
          action = 'canonical_intact_old_missing';
          if (fs.existsSync(partialPath)) {
            try { fs.unlinkSync(partialPath); } catch (_) {}
          }
        } else {
          action = 'unexpected_file_state_after_swap';
          recovered = false;
        }
      }
      // Crash Case A: Interrupted during Remuxing, Structure Verifying, or Pending
      else if (
        state === NormalizationState.REMUXING ||
        state === NormalizationState.STRUCTURE_VERIFYING ||
        state === NormalizationState.PENDING ||
        state === NormalizationState.VERIFIED
      ) {
        if (fs.existsSync(partialPath)) {
          try {
            fs.unlinkSync(partialPath);
            action = 'cleaned_orphan_partial';
          } catch (e) {
            action = `failed_clean_partial: ${e.message}`;
            recovered = false;
          }
        } else {
          action = 'no_artifacts_original_intact';
        }
      }

      this.recordState(canonical, NormalizationState.FAILED_SAFE, {
        recoveryAction: action,
        recoveredAt: new Date().toISOString(),
        recoverySuccess: recovered
      });

      if (!recovered) {
        unrecovered.push(canonical);
      }
      actions.push({ originalPath: canonical, action, recovered, stateBeforeRecovery: state });
    }

    return {
      ok: unrecovered.length === 0,
      status: unrecovered.length === 0 ? 'RECOVERED_SAFE' : 'RECOVERY_BLOCKED',
      actions,
      unrecovered
    };
  }
}
