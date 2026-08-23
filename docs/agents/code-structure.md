# Code structure guardrails

These rules apply to agent-authored source code in this repository, including prototypes.

## Hard file-size limit

- A hand-written source/code file must not exceed **600 physical lines**.
- This applies to HTML, CSS, JavaScript/TypeScript, Python, PowerShell, shell scripts, and similar authored code files.
- **Prototype/throwaway status is not an exception.** Prototypes must still remain agent-readable and modular.
- Generated, vendored, minified, lock/data, or other machine-owned files are outside this limit unless an agent is directly maintaining them as source.

## Required behavior

- Refactor before a hand-written source file crosses 600 lines; do not knowingly commit a new or modified authored source file above the limit.
- Split by responsibility into small modules/components with explicit interfaces. Prefer cohesive modules over arbitrary line-based chopping.
- If a task touches an existing source file already above 600 lines, do not make it larger. Create a safe seam and reduce/split it before adding further behavior.
- At the end of implementation/prototype work, check the line counts of authored source files changed by the task and report any violation as a blocker rather than silently committing it.

## Why this exists

Very large files degrade agent navigation, review quality, locality, and change safety. The 600-line ceiling is a project-level guardrail for keeping the working set understandable to IDE agents and humans.
