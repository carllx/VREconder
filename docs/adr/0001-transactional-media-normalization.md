# ADR 0001: Transactional In-Place Media Normalization with Safe Journal

## Status

Accepted

## Context

iPhone Safari VR Web Player playback requires specific media container packaging (e.g. `hvc1` MP4 stream packaging rather than `hev1`). Storing permanent duplicate copies across a large media library causes substantial disk bloat and library divergence. The user has authorized a single authoritative physical copy per Logical Media via in-place normalization, provided no media data is ever lost during normalization, crashes, or power failures.

## Decision

We adopt a crash-safe transactional replace state machine for media library normalization:

1. **User-Authorized Single-Copy Model**: Normalization operates in-place on target files, keeping exactly one formal physical media file per Logical Media upon completion.
2. **Hard Preservation Invariant**: The original media file is strictly retained and never deleted until the normalized replacement has passed complete ffprobe structure checks, packet/stream equivalence validation, and full demux verification.
3. **Crash-Safe Journaling**: Every step (`PENDING`, `REMUXING`, `STRUCTURE_VERIFYING`, `VERIFIED`, `SWAPPING`, `FINAL_VERIFYING`, `DONE`, `FAILED_SAFE`) is recorded in an atomic append-only journal before filesystem operations occur.
4. **Isolated Temporary Pipeline**: Remuxing outputs to a temporary file (`.<name>.vreconder.partial`). On verification success, the original is renamed to `.<name>.vreconder-old`, the partial is promoted to the canonical filename, final verification executes, and only then is `.<name>.vreconder-old` unlinked.
5. **Fail-Safe Recovery**: Any error, crash, interruption, or disk space exhaustion restores or preserves the original media. No file is unlinked based on unjournaled filename heuristics.

## Consequences

- Zero risk of destructive media loss or silent corruption during batch normalization.
- Requires temporary free disk space equal to at least one largest candidate file plus margin before processing any candidate.
- Recovery logic on engine startup inspects the journal and safely rolls back partial/stale states to guaranteed original files.
