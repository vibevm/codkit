---
paths:
  - "packages/**"
---

# Codkit clean-room development

Implement from Codkit specs, tests, and existing Codkit code only. Do not read or
copy old implementations or reference repositories. Machine-local reference
paths belong only in `.claude/settings.local.json`; never commit them.

Use our terminology and run the focused test, typecheck, formatting, structural
scope, and clean-room gates applicable to the change. Do not weaken or filter a
red test to claim green. A reference comparison or an owner-only architecture
choice is a stop, not an inference.
