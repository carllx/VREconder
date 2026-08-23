## Agent skills

### Issue tracker

GitHub issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The default 5 canonical roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (`CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.

## Code structure guardrails

Hand-written source/code files must not exceed **600 physical lines**, including throwaway prototypes. Refactor by responsibility before crossing the limit, and do not add behavior to an already-oversized source file until a safe modular seam is created. See `docs/agents/code-structure.md`.
