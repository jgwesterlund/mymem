# Known issues

- **F1 (upstream @tiptap/markdown 3.26.0):** loose-form nested GFM task lists drop siblings
  after a nested sublist on first parse (`- [ ] parent\n\n  - [x] child\n\n  - [ ] child two`
  → "child two" vanishes from the doc). Our serializer only emits tight form, so app-authored
  notes are unaffected; loss occurs only when EDITING an externally-authored loose-form note
  (the seeded baseline means merely opening it writes nothing). Re-test on TipTap upgrades;
  consider a parse-time normalizer in the M4 import pipeline.
- **F2 (bounded save retry):** on CAS conflict with multiple flushes parked on the same
  in-flight save, each parked flush re-fires one duplicate (rejected) save with the same stale
  base — bounded at ≤ ~3 attempts, no data written, no spin. Cosmetic; revisit with the M7
  agent-edit conflict UX.
- **Quit flush window:** `beforeunload` cannot await IPC; a keystroke made <800 ms before
  Cmd+Q relies on the blur-flush. Acceptable per review; a main-side before-quit handshake is
  the upgrade path if dogfooding shows loss.
