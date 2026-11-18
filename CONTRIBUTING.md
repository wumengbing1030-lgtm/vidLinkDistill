# Contributing to 万链凝识 (vidLinkDistill)

Thanks for considering a contribution. This project is small and opinionated — the notes it produces have a specific shape, and preserving that shape matters more than adding features.

## Before you start

Open an Issue first for anything non-trivial (a new source platform, a schema change, a pipeline stage). Bug reports can go straight to the template.

## What counts as a good contribution

- **A real failure you hit**, with the video (or a sanitized `digest.md`) attached
- **A fix that keeps the invariants** listed below
- **Documentation** for something you had to figure out the hard way

## Invariants (please don't break these)

1. **No hallucinated content.** Every knowledge point must trace to a timestamp that exists in `digest.md`. If it isn't in the source, it doesn't go in the note.
2. **Numbers are sacred.** Key figures from the original must be preserved in the plain-language version, and no new numbers may appear. The gate normalizes Chinese numerals and "翻倍/两倍" before comparing — keep that behavior.
3. **Plain-language means plain.** No 黑话词 (赋能 / 抓手 / 闭环 / 颗粒度 / 对齐 / 落地) in `plain`. If you can't say it without jargon, you haven't explained it.
4. **The gate must pass.** `check_notes.js` exits non-zero on objective defects. Never hand-edit `notes.md` to bypass it — fix the source `notes.json`.
5. **Nothing leaves the machine.** No new outbound calls to third-party services with user content. All processing stays local.
6. **No credentials in the repo.** No cookies, no `.sessdata`, no keys.

## Development setup

```bash
git clone https://github.com/wumengbing1030-lgtm/vidLinkDistill.git
cd vidLinkDistill
pip install -r requirements.txt

# start the daemons
python scripts/transcribe_daemon.py
python scripts/ocr_daemon.py
```

Run the gate and the renderer on a real `notes.json` before opening a PR:

```bash
node scripts/check_notes.js work/<BV>_P1/notes.json --digest=work/<BV>_P1/digest.md
node scripts/render.js work/<BV>_P1/notes.json --html
```

## Commit and PR conventions

- Branch names: `feat/…`, `fix/…`, `docs/…`
- Commit messages: `feat: …` / `fix: …` / `docs: …` / `chore: …`
- One logical change per PR; unrelated refactors make review harder
- Update `CHANGELOG.md` under the Unreleased or next version heading
- If you change the note schema, update `references/notes-schema.md` **and** `examples/notes.sample.md` together

## Adding a new video platform

1. Add a resolver in `scripts/kb.js` that returns a normalized descriptor (`title`, `duration`, `streams`, `subtitles`)
2. Prefer the official subtitle API; fall back to local transcription
3. Add a row to the site-status table in `README.md` / `README_EN.md` — **be honest about what you actually tested**
4. Add a fixture-level test; never commit media files

## Code of conduct

Be accurate and kind. Assume the other person spent time on the same problem.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
