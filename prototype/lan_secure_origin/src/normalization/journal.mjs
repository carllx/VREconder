import fs from 'node:fs';
import path from 'node:path';

export const NormalizationState = {
  PENDING: 'PENDING',
  REMUXING: 'REMUXING',
  STRUCTURE_VERIFYING: 'STRUCTURE_VERIFYING',
  VERIFIED: 'VERIFIED',
  SWAPPING: 'SWAPPING',
  FINAL_VERIFYING: 'FINAL_VERIFYING',
  DONE: 'DONE',
  FAILED_SAFE: 'FAILED_SAFE',
  WAITING_DEVICE: 'WAITING_DEVICE',
  PAUSED_FOR_PLAYBACK: 'PAUSED_FOR_PLAYBACK'
};

export class NormalizationJournal {
  constructor(journalFilePath) {
    this.journalFilePath = path.resolve(journalFilePath);
    this.ensureJournalFile();
  }

  ensureJournalFile() {
    const dir = path.dirname(this.journalFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.journalFilePath)) {
      fs.writeFileSync(this.journalFilePath, JSON.stringify({ version: 1, entries: {} }, null, 2), 'utf8');
    }
  }

  readJournal() {
    try {
      this.ensureJournalFile();
      const content = fs.readFileSync(this.journalFilePath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      return { version: 1, entries: {} };
    }
  }

  writeJournal(data) {
    const tmp = `${this.journalFilePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.journalFilePath);
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
   * Performs crash recovery scan on startup.
   * Restores any swapped-out old original files and cleans up orphaned .partial files.
   * 
   * @returns {Array<{ originalPath: string, action: string, recovered: boolean }>}
   */
  recoverOnStartup() {
    const journal = this.readJournal();
    const recoveryActions = [];

    for (const [canonical, entry] of Object.entries(journal.entries)) {
      const state = entry.currentState;
      if (state === NormalizationState.DONE || state === NormalizationState.FAILED_SAFE) {
        continue;
      }

      const dir = path.dirname(canonical);
      const ext = path.extname(canonical);
      const base = path.basename(canonical, ext);
      const partialPath = path.join(dir, `.${base}${ext}.vreconder.partial`);
      const oldPath = path.join(dir, `.${base}${ext}.vreconder-old`);

      let action = 'none';
      let recovered = true;

      if (state === NormalizationState.SWAPPING || state === NormalizationState.FINAL_VERIFYING) {
        // Interrupted during or after rename
        if (fs.existsSync(oldPath) && !fs.existsSync(canonical)) {
          // Original was renamed to .vreconder-old but target was not finalized -> Rollback
          try {
            fs.renameSync(oldPath, canonical);
            action = 'restored_old_to_original';
          } catch (e) {
            action = `failed_restore_old: ${e.message}`;
            recovered = false;
          }
        } else if (fs.existsSync(oldPath) && fs.existsSync(canonical)) {
          // Both exist: if crash occurred before old removal, keep original intact
          action = 'preserved_both_for_safety';
        }
      } else if (state === NormalizationState.REMUXING || state === NormalizationState.STRUCTURE_VERIFYING) {
        // Interrupted while remuxing or verifying partial: remove partial, original is untouched
        if (fs.existsSync(partialPath)) {
          try {
            fs.unlinkSync(partialPath);
            action = 'cleaned_orphan_partial';
          } catch (e) {
            action = `failed_clean_partial: ${e.message}`;
          }
        }
      }

      this.recordState(canonical, NormalizationState.FAILED_SAFE, {
        recoveryAction: action,
        recoveredAt: new Date().toISOString()
      });

      recoveryActions.push({ originalPath: canonical, action, recovered });
    }

    return recoveryActions;
  }
}
