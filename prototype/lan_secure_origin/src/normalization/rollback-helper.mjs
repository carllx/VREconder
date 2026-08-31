import fs from 'node:fs';

export const RollbackStatus = {
  ROLLBACK_OK: 'ROLLBACK_OK',
  ROLLBACK_NOT_REQUIRED: 'ROLLBACK_NOT_REQUIRED',
  ROLLBACK_BLOCKED: 'ROLLBACK_BLOCKED'
};

/**
 * Executes a deterministic fail-closed rollback transaction.
 *
 * Invariants:
 * 1. If swap has occurred (isSwapped === true or oldPath exists):
 *    - Verify oldPath exists and matches initialFingerprint before performing mutations.
 *      If oldPath missing or invalid: ROLLBACK_BLOCKED (never delete anything!).
 *    - If canonical exists, unlink canonical (this is the candidate/partial replacement).
 *      If unlink canonical fails: ROLLBACK_BLOCKED (never touch oldPath!).
 *    - Rename oldPath -> canonical.
 *      If rename fails: ROLLBACK_BLOCKED.
 *    - Verify canonical now matches initialFingerprint.
 *      If mismatch: ROLLBACK_BLOCKED.
 *    - If partialPath exists, unlink partialPath.
 *      If unlink partial fails: ROLLBACK_BLOCKED.
 *
 * 2. If swap has not occurred (unswapped):
 *    - Unlink partialPath if it exists.
 *      If unlink fails: ROLLBACK_BLOCKED.
 *    - Verify canonical exists and matches initialFingerprint (if provided).
 *      If missing or invalid: ROLLBACK_BLOCKED.
 *
 * 3. Never swallow filesystem exceptions. All operations run through provided fileOps
 *    for deterministic testing / fault injection without fragile global monkey patching.
 *
 * @param {object} params
 * @param {string} params.canonical
 * @param {string} params.oldPath
 * @param {string} params.partialPath
 * @param {boolean} [params.isSwapped]
 * @param {object} [params.initialFingerprint]
 * @param {object} [params.fileOps]
 * @returns {{ ok: boolean, status: string, error?: string, details?: object }}
 */
export function executeRollback({
  canonical,
  oldPath,
  partialPath,
  isSwapped = false,
  initialFingerprint = null,
  fileOps = {}
}) {
  const _unlinkSync = fileOps.unlinkSync || fs.unlinkSync;
  const _renameSync = fileOps.renameSync || fs.renameSync;
  const _existsSync = fileOps.existsSync || fs.existsSync;
  const _statSync = fileOps.statSync || fs.statSync;

  const checkFingerprint = (targetPath, expectedFp) => {
    if (!expectedFp) return true;
    try {
      if (!_existsSync(targetPath)) return false;
      const st = _statSync(targetPath);
      return st.size === expectedFp.sizeBytes && Math.floor(st.mtimeMs) === expectedFp.mtimeMs;
    } catch (_) {
      return false;
    }
  };

  try {
    const oldExists = _existsSync(oldPath);
    const canonicalExists = _existsSync(canonical);
    const partialExists = _existsSync(partialPath);

    // Case 1: Swapped state (or .old exists)
    if (isSwapped || oldExists) {
      if (!oldExists) {
        return {
          ok: false,
          status: RollbackStatus.ROLLBACK_BLOCKED,
          error: 'SWAP_ROLLBACK_FAILED_OLD_BACKUP_MISSING'
        };
      }

      // Verify .old backup matches recorded initial fingerprint before mutating anything
      if (initialFingerprint && !checkFingerprint(oldPath, initialFingerprint)) {
        return {
          ok: false,
          status: RollbackStatus.ROLLBACK_BLOCKED,
          error: 'SWAP_ROLLBACK_FAILED_OLD_FINGERPRINT_MISMATCH'
        };
      }

      // If canonical exists (e.g. replacement file), unlink it first
      if (canonicalExists) {
        try {
          _unlinkSync(canonical);
        } catch (unlinkErr) {
          return {
            ok: false,
            status: RollbackStatus.ROLLBACK_BLOCKED,
            error: `SWAP_ROLLBACK_UNLINK_CANONICAL_FAILED: ${unlinkErr.message}`
          };
        }
      }

      // Restore original backup: oldPath -> canonical
      try {
        _renameSync(oldPath, canonical);
      } catch (renameErr) {
        return {
          ok: false,
          status: RollbackStatus.ROLLBACK_BLOCKED,
          error: `SWAP_ROLLBACK_RENAME_OLD_TO_CANONICAL_FAILED: ${renameErr.message}`
        };
      }

      // Invariant: Verify canonical is now restored and matches initial fingerprint
      if (initialFingerprint && !checkFingerprint(canonical, initialFingerprint)) {
        return {
          ok: false,
          status: RollbackStatus.ROLLBACK_BLOCKED,
          error: 'SWAP_ROLLBACK_RESTORED_CANONICAL_FINGERPRINT_MISMATCH'
        };
      }

      // Clean orphan partial if left over
      if (_existsSync(partialPath)) {
        try {
          _unlinkSync(partialPath);
        } catch (unlinkPartialErr) {
          return {
            ok: false,
            status: RollbackStatus.ROLLBACK_BLOCKED,
            error: `SWAP_ROLLBACK_UNLINK_PARTIAL_FAILED: ${unlinkPartialErr.message}`
          };
        }
      }

      return {
        ok: true,
        status: RollbackStatus.ROLLBACK_OK
      };
    }

    // Case 2: Unswapped state (canonical was never renamed to oldPath)
    if (partialExists) {
      try {
        _unlinkSync(partialPath);
      } catch (unlinkPartialErr) {
        return {
          ok: false,
          status: RollbackStatus.ROLLBACK_BLOCKED,
          error: `UNSWAPPED_ROLLBACK_UNLINK_PARTIAL_FAILED: ${unlinkPartialErr.message}`
        };
      }
    }

    // Verify canonical is still present and matches initial fingerprint if provided
    if (canonicalExists) {
      if (initialFingerprint && !checkFingerprint(canonical, initialFingerprint)) {
        return {
          ok: false,
          status: RollbackStatus.ROLLBACK_BLOCKED,
          error: 'UNSWAPPED_ROLLBACK_CANONICAL_FINGERPRINT_MISMATCH'
        };
      }
    } else {
      return {
        ok: false,
        status: RollbackStatus.ROLLBACK_BLOCKED,
        error: 'UNSWAPPED_ROLLBACK_CANONICAL_MISSING'
      };
    }

    return {
      ok: true,
      status: partialExists ? RollbackStatus.ROLLBACK_OK : RollbackStatus.ROLLBACK_NOT_REQUIRED
    };
  } catch (err) {
    return {
      ok: false,
      status: RollbackStatus.ROLLBACK_BLOCKED,
      error: `UNEXPECTED_ROLLBACK_EXCEPTION: ${err.message}`
    };
  }
}
