# VidLink Distill (万链凝识)

Turn **one video link** into a **mobile-friendly structured knowledge note**: timestamped transcript fused with keyframe OCR (slides / whiteboard / formulas / tables), ads and filler removed, knowledge points graded and numbered, each point carrying **both** a faithful summary and a plain-language version, plus a mind-map outline.

> **The claim:** every conclusion traces back to a timestamp, every technical passage has a version a non-expert can follow, and the whole thing has a skeleton you can grasp at a glance.

```
Input : a video link (Bilibili / YouTube / podcast / course / interview / livestream replay)
Output: content map → graded knowledge points → dual-version wording → mind-map outline
```

[中文文档](README.md) · [MIT License](LICENSE)

---

## What problem it solves

Watching a 55-minute technical talk, the real loss isn't "no time to finish." It's:

- three great sentences drowned in 5,000 words of filler — no way to find them again
- architecture diagrams, formulas, comparison tables on screen: subtitle-only tools get **nothing**
- "铁不到盐" transcribed where the speaker said "吃不到盐" — homophone errors nobody flags
- ten elegant summary bullets you still don't understand, because they assume you're a peer

This tool handles all four together: **timestamp traceability, keyframe OCR, audio-visual cross-checking, dual-version wording.**

---

## How it differs from similar tools

| Tool | Output | Use it for |
|---|---|---|
| **VidLink Distill (this)** | A re-readable **layered note** | Want to understand, look back, and search later |
| [cangjie-skill](https://github.com/) | **Executable agent skills** | Want a method turned into a capability |
| book-distill | Book → knowledge base + skill cards | Want a book turned into a queryable library |
| Ordinary video summarizers | A paragraph summary | Only want to know what it said |

**Complementary, not competing**: need *capability* → cangjie; need to *read and understand* → this.

---

## Requirements

Python ≥ 3.10, Node ≥ 18.

```bash
git clone https://github.com/wumengbing1030-lgtm/vidLinkDistill.git
cd vidLinkDistill
pip install -r requirements.txt   # faster-whisper / rapidocr-onnxruntime / av / numpy / yt-dlp / zhconv
```

Put the folder in your agent's skills directory:

```bash
cp -r vidLinkDistill ~/.workbuddy/skills/     # WorkBuddy (user-level, all projects)
cp -r vidLinkDistill ~/.claude/skills/        # Claude Code / Codex / Cursor
```

First run downloads the whisper-small model (~480 MB) — slow once, fast after.

---

## Supported sources

| Source | How | Status |
|---|---|---|
| **Bilibili** | paste link or the whole share text; `?p=3` auto-detects the part | ✅ stable; with SESSDATA, official subtitles in seconds |
| **Any site** | paste the link; routed through yt-dlp (1,754 site extractors) | ✅ YouTube verified: 480p video + audio + site subtitles |
| **Local file** | `--file="D:/v.mp4"`, optional `--sub=x.srt` | ✅ mp4 / m4a / webm / mkv |

| Site | Status |
|---|---|
| YouTube / Vimeo / Dailymotion / TED | ✅ stable, usually has captions |
| 西瓜视频 / 微博视频 | ✅ usually parses; local transcription if no captions |
| 抖音 / TikTok | ⚠️ most need browser cookies; some public ones work |
| 小红书 | ⚠️ same, plus anti-hotlink |
| 腾讯视频 / 爱奇艺 / 优酷 / 芒果 | ❌ member content is DRM-encrypted; no tool can open it |
| 视频号 | ❌ no public API — screen-record or export, then use `--file=` |

**The fallback always works**: any file you can obtain (browser extension, screen recording, official export) runs fine via `--file=`.

---

## Usage

### In conversation

```
Distill this video into notes https://www.bilibili.com/video/BV1xxxxxxxxx
SESSDATA=xxxx   (optional — official subtitles, zero typos)
```

### From the command line

```bash
# 1) start the two daemons
python scripts/transcribe_daemon.py     # 127.0.0.1:8766
python scripts/ocr_daemon.py            # 127.0.0.1:8767
# Windows: scripts/start_daemons.bat

# 2) collect: subtitles/transcription + keyframe OCR → digest.md
node scripts/kb.js "https://www.bilibili.com/video/BV1xxxxxxxxx" --frames=20
node scripts/kb.js --file="D:/videos/talk.mp4" --sub="D:/videos/talk.srt"

# 3) write work/<BV>_P1/notes.json (see references/notes-schema.md)

# 4) quality gate — must PASS
node scripts/check_notes.js work/BV1xxxxxxxxx_P1/notes.json --digest=work/BV1xxxxxxxxx_P1/digest.md

# 5) render
node scripts/render.js work/BV1xxxxxxxxx_P1/notes.json --rag --html
```

### A whole series (multi-part / playlist)

```bash
node scripts/kb-batch.js --url="https://www.bilibili.com/video/BV1xxxxxxxxx" --list
node scripts/kb-batch.js --url="https://www.bilibili.com/video/BV1xxxxxxxxx" --sessdata=xxx
node scripts/kb-batch.js --url="https://www.bilibili.com/video/BV1xxxxxxxxx" --index
```

Output lands in `out/<series>/`: `index.md` (status table + per-episode topic index + cross-episode thread) plus `P01-xxx.md` per episode.

### Key flags

| Flag | Meaning | Default |
|---|---|---|
| `--sessdata=xxx` | use official subtitles (B站) | none |
| `--frames=N` | keyframe cap — 24–36 for lectures, 12 for talking heads | 20 |
| `--budget=N` | digest word cap (use 30000 for long videos) | 15000 |
| `--from=N` | only process after second N | 0 |
| `--model=size` | whisper model (tiny/base/small) | small |
| `--file=path` | use a local file instead of a link | none |
| `--sub=path` | attach an external srt/vtt | none |
| `--lite` | slim mode | full |
| `--ocr=off` | skip frame OCR, audio only (much faster) | on |
| `--remote=off` | force local video download for frames | remote streaming |
| `--dlparts=N` | download concurrency (audio 4 / video 6) | — |
| `--html` (render.js) | also emit a self-contained mobile-friendly page | Markdown only |

---

## What the output looks like

```markdown
## 内容地图

共 7 个主题 / 23 条知识点

| # | 主题 | 时间段 | 条数 | 小标题 |
|---|------|--------|------|--------|
| 1 | 核心心智模型：带 AI 助手＝带工程团队 | 0:00–4:47 | 4 | 敢不敢放手决定并行度 |

## 1. 核心心智模型：带 AI 助手＝带工程团队

`0:00–4:47`　·　4 条

### 1.1　⭐ ✅

**原话**　她直接把带 agent 类比成做工程经理：如果我不信任团队里的工程师，我的运作方式就会完全不同。

⏱ **音频时间**　`1:32`　·　音频

**简易理解**　就像你敢不敢把事情交给别人：敢放手，就能同时派好几拨人干活。
```

`--html` additionally produces `notes.html`: mobile-first, light/dark adaptive, highlighted core points, clickable TOC, single self-contained file you can forward as-is.

Full sample in [`examples/`](examples/).

---

## Performance

Measured on a 16-core / 32 GB machine:

| Scenario | Time |
|---|---|
| 55-minute video | **~3 min** (transcription and OCR in parallel) |
| 3-minute video | ~50 s (incl. download) |
| Re-run, same video | ~10 s (chunk cache hit) |
| Short video with official subtitles | usually < 40 s |

| Stage | Single connection | Optimized | Change |
|---|---|---|---|
| 32 MB audio download | 38 s | **9.8 s** (4 streams) | 3.8× faster |
| Frame OCR | needs the 32 MB video first | **remote streaming, 0 bytes downloaded** | one less full download |

---

## Design notes

**Why scripts + agent split**: collecting is deterministic work (download, decode, OCR, slicing) — that goes to scripts. Distilling is judgment work (what's worth writing, how to say it plainly) — that goes to the model. Mixing them means either half failing breaks everything.

**Why a quality gate**: the most common failure mode of a model writing notes isn't "bad writing" — it's quiet laziness: missing timestamps, plain-language sections written in jargon, the same sentence rephrased three times. All of those are machine-checkable objective defects, so `check_notes.js` blocks them directly rather than relying on repeated prompt nagging.

**Why keep `rejected.md`**: every dropped knowledge point must be able to explain why it was dropped, so "why didn't you include this one?" gets an immediate V1/V2/V3 answer instead of "I just felt it wasn't important."

---

## Known limitations

- **DRM / paid / private content is unreachable** — a platform limit, not an implementation gap.
- **Site parsers expire**: `pip install -U yt-dlp` usually fixes a site after a redesign.
- **Homophones**: local transcription can't fully fix them; burned-in captions help partially. Uncertain proper nouns are marked 📌.
- **Frame text**: pure talking-head or black frames yield nothing — that's normal.
- **Language**: Chinese is best; English works but proper nouns suffer on the `small` model. Other languages untested.
- **Platform**: subtitle API targets Bilibili. Other platforms need `kb.js` parsing changes; the rest of the pipeline is generic.

---

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The issue template asks for three things: what video, what environment, and what `digest.md` looked like.

---

## Compliance

For personal study and note-taking only. Respect the platform's terms of service and copyright law; do not use it for redistribution, scraping-and-reposting, or commercial use. The tool itself does not download, store, or redistribute video files — everything runs locally on your machine.

## License

MIT — see [LICENSE](LICENSE).
