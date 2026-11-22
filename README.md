[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/trtglhdry-commits/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/trtglhdry-commits/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies an edit an AI model wrote to a tree of text files. Models write edits in four formats, and mend
reads all of them: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and
text-editor tool calls as JSON. `SPEC.md` is the whole specification; `main.ts` implements all ten of its sections.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree. Every path in a patch is relative to it. When PATCH is absent or is
`-`, the patch is read from standard input.

## What it does

- **Three-tier matching (SPEC.md section 5).** Old lines are found at the first tier where they occur: tier 0
  exact, tier 1 trailing whitespace ignored, tier 2 leading and trailing whitespace ignored. `--strict` is tier 0
  only. The house baseline is a strict tier-0-only applier; mend beats it because the fuzzy tiers work: drifted
  indentation and trailing whitespace are matched, context lines are written as the file's own lines, and at tier 2
  the new lines are re-indented to the file's indentation.
- **Unified diffs (section 6).** Sections from `diff --git` lines or bare `---`/`+++` pairs; `rename from/to`,
  `new file mode`, `deleted file mode`; hunks applied in order, each taking the occurrence nearest its (often wrong)
  line number; `\ No newline at end of file` honoured; creations, deletions, moves (`R old -> new`) and changes.
- **SEARCH/REPLACE blocks (section 7).** Path taken from the nearest non-blank, non-fence line above the block, or
  the previous block's path; a block whose old lines occur more than once fails `ambiguous`.
- **V4A patches (section 8).** `*** Add File`, `*** Delete File`, `*** Update File` with optional `*** Move to:`,
  anchored chunks, a cursor that advances past each anchor and each write, and `*** End of File` chunks.
- **JSON edits (section 9).** Array form or JSON Lines; `create`, `str_replace` (exact, overlapping positions
  counted), `insert` (line-count range checked), with CRLF files round-tripped.
- **All or nothing (section 10).** Edits apply in patch order to the tree as earlier edits left it; a failed edit
  changes nothing and the edits after it still run; when any edit failed, no file is written.

## Practice score

`node check.ts <kit>/program/generator/practice.json` on the kit's 100 public practice checks:

| format | passed |
| --- | --- |
| unified | 30 / 30 |
| search_replace | 20 / 20 |
| v4a | 20 / 20 |
| json | 15 / 15 |
| cli | 15 / 15 |
| **total** | **100 / 100 — practice score 1000** |

Deterministic: repeated runs of the checker give identical results.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to `runner.ts`
  when `MAKEFUN_ENV_URL` is set; keep them.
- `runner.ts` — keep as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a
  fresh directory, and posts what main.ts did.
- `check.ts` — the practice set on your own machine.
- `SPEC.md` — the specification.

## Referral

Made with [make.fun](https://make.fun/r/yhmjkzq7) — referral code `yhmjkzq7`.
