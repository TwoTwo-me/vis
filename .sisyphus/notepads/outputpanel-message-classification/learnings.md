## 2026-02-08 Task: bootstrap
- Message-level diffs are collected in `messageDiffsByKey` in `app/App.vue`.
- Output panel currently renders all non-subagent messages in `app/components/OutputPanel.vue`.

## 2026-02-09 Task 2: round-grouped fetchHistory
- `fetchHistory` now groups by `parentID` and creates one `isRound` entry per top-level message with `roundMessages` sorted by `messageTime` (fallback: original list order).
- Summary diffs are attached directly to each round root via `extractSummaryDiffs(root.info)` and stored in `messageDiffsByKey` by the round's `messageKey`.
