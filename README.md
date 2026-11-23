# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wandy90/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wandy90/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is a single command-line tool that applies the edits AI models write, in four formats — unified diff, SEARCH/REPLACE, V4A patch, and JSON tool calls — to a tree of files. It changes all files or none. Line matching runs in three tiers (exact, trailing-whitespace-insensitive, then whitespace-insensitive with re-indentation); `--strict` restricts matching to exact only. All edits in one patch are applied atomically: if any edit fails, no file is written.

## Run it

```sh
node main.ts [options] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=sr8ktej6&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

## Formats

- **Unified diff** — `diff --git` sections and `---`/`+++` pairs, including renames, new/deleted files, and hunks whose `@@` line numbers are wrong (matched by nearest occurrence instead).
- **SEARCH/REPLACE** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks, exactly-once matching; an empty old block creates a file.
- **V4A patch** — `*** Begin Patch` / `*** End Patch`, with Add / Delete / Update sections, `*** Move to:`, anchor `@@` chunks, a forward-moving cursor, and `*** End of File`.
- **JSON tool calls** — `create`, `str_replace`, `insert`, `delete`, `move`, `rename`, and `shell` edits from JSON input.

## Usage

Requires Node 22, standard library only — no dependencies. Input can come from a file argument or stdin. See `SPEC.md` for the full specification, including exit codes, output format, `--check`, and path-safety rules.

## Practice result

Verified 23 November 2026 with Node v22.23.5:

- **100 of 100 practice checks passed — practice score 1000**
- Unified 30/30, SEARCH/REPLACE 20/20, V4A 20/20, JSON 15/15, CLI 15/15

Practice checks are public; the scored checks are drawn after the deadline from a sealed pool, so the practice score is not the final score.

## Files

- `main.ts` — the CLI (the entry)
- `runner.ts` — trial runner; keep as is
- `check.ts` — runs the practice set locally: `node check.ts ../program/generator/practice.json`
- `SPEC.md` — the specification
- `LICENSE` — MIT

Built for the make.fun bounty "Build mend, one patch tool for every AI edit format".
