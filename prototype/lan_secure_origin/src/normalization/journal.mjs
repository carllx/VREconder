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
      history: []
    };

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

      let action = 'none';
      let recovered = true;

      // Crash Case 1: Interrupted after Step 1 (original was renamed to .old, but partial not yet renamed to canonical)
      if (state === NormalizationState.SWAP_STEP1_RENAME_ORIGINAL) {
        if (fs.existsSync(oldPath) && !fs.existsSync(canonical)) {
          try {
            fs.renameSync(oldPath, canonical);
            action = 'restored_old_to_canonical';
          } catch (e) {
            action = `failed_restore_old: ${e.message}`;
            recovered = false;
          }
        } else if (!fs.existsSync(oldPath) && fs.existsSync(canonical)) {
          action = 'canonical_intact_old_missing';
        } else {
          action = 'unexpected_file_state_after_step1';
          recovered = false;
        }
        if (fs.existsSync(partialPath)) {
          try { fs.unlinkSync(partialPath); } catch (_) {}
        }
      }
      // Crash Case 2: Interrupted during Step 2 or Final Verifying (both old and canonical exist, or partial was renamed)
      else if (state === NormalizationState.SWAP_STEP2_RENAME_PARTIAL || state === NormalizationState.FINAL_VERIFYING) {
        if (fs.existsSync(oldPath) && fs.existsSync(canonical)) {
          // Unfinalized state: rollback canonical to old
          try {
            fs.unlinkSync(canonical);
            fs.renameSync(oldPath, canonical);
            action = 'rolled_back_partial_restored_old';
          } catch (e) {
            action = `failed_rollback: ${e.message}`;
            recovered = false;
          }
        } else if (fs.existsSync(oldPath) && !fs.existsSync(canonical)) {
          try {
            fs.renameSync(oldPath, canonical);
            action = 'restored_old_to_canonical';
          } catch (e) {
            action = `failed_restore_old: ${e.message}`;
            recovered = false;
          }
        }
      }
      // Crash Case 3: Interrupted during Remuxing or Structure Verifying
      else if (state === NormalizationState.REMUXING || state === NormalizationState.STRUCTURE_VERIFYING || state === NormalizationState.PENDING || state === NormalizationState.VERIFIED) {
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
