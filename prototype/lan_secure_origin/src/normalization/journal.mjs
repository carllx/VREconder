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
  CLEANUP_PENDING: 'CLEANUP_PENDING',
  DONE: 'DONE',
  FAILED_SAFE: 'FAILED_SAFE',
  PAUSED_FOR_PLAYBACK: 'PAUSED_FOR_PLAYBACK',
  CANCELLED: 'CANCELLED',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED'
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
      replacementFingerprint: meta.replacementFingerprint || null,
      history: []
    };

    if (meta.initialFingerprint && !existing.initialFingerprint) {
      existing.initialFingerprint = meta.initialFingerprint;
    }
    if (meta.replacementFingerprint) {
      existing.replacementFingerprint = meta.replacementFingerprint;
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
      // Skip completed or terminal safe entries
      if (state === NormalizationState.DONE || state === NormalizationState.FAILED_SAFE || state === NormalizationState.CANCELLED) {
        continue;
      }

      const dir = path.dirname(canonical);
      const ext = path.extname(canonical);
      const base = path.basename(canonical, ext);
      const partialPath = path.join(dir, `.${base}${ext}.vreconder.partial`);
      const oldPath = path.join(dir, `.${base}${ext}.vreconder-old`);
      const recordedFingerprint = entry.initialFingerprint || entry.meta?.initialFingerprint || null;
      const replacementFingerprint = entry.replacementFingerprint || entry.meta?.replacementFingerprint || null;

      let action = 'none';
      let recovered = true;
      let targetTerminalState = NormalizationState.FAILED_SAFE;

      const checkFp = (target, fp) => {
        if (!fp) return true;
        try {
          if (!fs.existsSync(target)) return false;
          const st = fs.statSync(target);
          return st.size === fp.sizeBytes && Math.floor(st.mtimeMs) === fp.mtimeMs;
        } catch (_) {
          return false;
        }
      };

      // Case 1: FINAL_VERIFIED or CLEANUP_PENDING
      if (state === NormalizationState.FINAL_VERIFIED || state === NormalizationState.CLEANUP_PENDING) {
        const canonicalMatchesReplacement = checkFp(canonical, replacementFingerprint);

        if (!canonicalMatchesReplacement) {
          action = 'replacement_fingerprint_mismatch_recovery_blocked';
          recovered = false;
        } else {
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
            targetTerminalState = NormalizationState.DONE;
          }
        }
      }
      // Case 2: PAUSED_FOR_PLAYBACK (Transient state invariant validation)
      else if (state === NormalizationState.PAUSED_FOR_PLAYBACK) {
        if (fs.existsSync(oldPath)) {
          action = 'paused_unexpected_old_backup_recovery_blocked';
          recovered = false;
        } else {
          if (fs.existsSync(partialPath)) {
            try {
              fs.unlinkSync(partialPath);
            } catch (e) {
              action = `paused_failed_clean_partial: ${e.message}`;
              recovered = false;
            }
          }
          if (recovered) {
            if (fs.existsSync(canonical) && checkFp(canonical, recordedFingerprint)) {
              action = 'paused_clean_state_verified';
              targetTerminalState = NormalizationState.CANCELLED;
            } else {
              action = 'paused_canonical_mismatch_recovery_blocked';
              recovered = false;
            }
          }
        }
      }
      // Case 3: RECOVERY_REQUIRED or Interrupted Swap States (SWAP_STEP1, SWAP_STEP2, FINAL_VERIFYING)
      else if (
        state === NormalizationState.RECOVERY_REQUIRED ||
        state === NormalizationState.SWAP_STEP1_RENAME_ORIGINAL ||
        state === NormalizationState.SWAP_STEP2_RENAME_PARTIAL ||
        state === NormalizationState.FINAL_VERIFYING
      ) {
        if (fs.existsSync(oldPath)) {
          const oldMatchesOriginal = checkFp(oldPath, recordedFingerprint);
          if (!oldMatchesOriginal) {
            action = 'artifact_fingerprint_mismatch_recovery_blocked';
            recovered = false;
          } else {
            try {
              if (fs.existsSync(canonical)) {
                fs.unlinkSync(canonical);
              }
              fs.renameSync(oldPath, canonical);
              if (fs.existsSync(partialPath)) {
                try { fs.unlinkSync(partialPath); } catch (_) {}
              }
              if (checkFp(canonical, recordedFingerprint)) {
                action = 'rolled_back_to_proven_original';
              } else {
                action = 'rollback_canonical_fingerprint_mismatch_recovery_blocked';
                recovered = false;
              }
            } catch (e) {
              action = `failed_rollback: ${e.message}`;
              recovered = false;
            }
          }
        } else if (!fs.existsSync(oldPath) && fs.existsSync(canonical)) {
          if (state === NormalizationState.SWAP_STEP1_RENAME_ORIGINAL || (state === NormalizationState.RECOVERY_REQUIRED && checkFp(canonical, recordedFingerprint))) {
            if (checkFp(canonical, recordedFingerprint)) {
              action = 'canonical_intact_old_missing';
              if (fs.existsSync(partialPath)) {
                try { fs.unlinkSync(partialPath); } catch (_) {}
              }
            } else {
              action = 'step1_canonical_mismatch_recovery_blocked';
              recovered = false;
            }
          } else {
            action = 'swap_incomplete_old_backup_missing_recovery_blocked';
            recovered = false;
          }
        } else {
          action = 'unexpected_file_state_after_swap';
          recovered = false;
        }
      }
      // Case 4: Pre-swap states (REMUXING, STRUCTURE_VERIFYING, PENDING, VERIFIED)
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

        if (recovered && !checkFp(canonical, recordedFingerprint)) {
          action = 'canonical_corrupted_recovery_blocked';
          recovered = false;
        }
      }

      if (recovered) {
        this.recordState(canonical, targetTerminalState, {
          recoveryAction: action,
          recoveredAt: new Date().toISOString(),
          recoveredFrom: state,
          recoverySuccess: true
        });
      } else {
        this.recordState(canonical, NormalizationState.RECOVERY_REQUIRED, {
          recoveryAction: action,
          recoveredAt: new Date().toISOString(),
          recoveredFrom: state,
          recoverySuccess: false
        });
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
