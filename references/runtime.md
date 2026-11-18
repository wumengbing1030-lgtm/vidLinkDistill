# 运行环境与前置服务

## 1. 依赖

Python ≥ 3.10，按 `requirements.txt` 装：

```bash
pip install -r requirements.txt
# faster-whisper / rapidocr-onnxruntime / av / numpy
```

Node ≥ 18（脚本零依赖，不需要 npm install）。

首次转写会从 hf-mirror 拉 whisper-small 模型（≈480MB），只有第一次慢。

## 2. 两个常驻服务

| 端口 | 脚本 | 作用 | 启动耗时 |
|---|---|---|---|
| 8766 | `scripts/transcribe_daemon.py` | faster-whisper 转写，多进程池（默认 4×4） | 预热 15–25 秒 |
| 8767 | `scripts/ocr_daemon.py` | RapidOCR 抽帧识别画面文字 | 约 3 秒 |

开工先查：

```bash
curl -s --noproxy '*' -m 3 http://127.0.0.1:8766/ping
curl -s --noproxy '*' -m 3 http://127.0.0.1:8767/ping
```

任一不通就启动（后台独立进程，不要阻塞当前 shell）：

```bash
PY="<你的 python 可执行文件>"
cd <skill>/scripts
HF_ENDPOINT=https://hf-mirror.com PYTHONIOENCODING=utf-8 "$PY" transcribe_daemon.py
PYTHONIOENCODING=utf-8 "$PY" ocr_daemon.py
```

Windows 用户也可直接双击 `scripts/start_daemons.bat`（先改里面的 `PY` 路径）。

`/ping` 返回 `workers: 4` 表示池已就绪；返回 `workers: 4` 但 `pids: []` 表示还在预热，等几秒。

## 3. 入库到资料库

用户确认入库后，把成品存进**「视频文件蒸馏」分组**（不存在就建）：

1. 加载 `library` 技能
2. `space.workspace.list-user-spaces` 取个人空间 `spaceId`
3. `space.workspace.list-node --space-id <id>` 看根目录有没有「视频文件蒸馏」文件夹：
   - 有 → 记下它的 `id` 复用
   - 没有 → `python manage/create_folder.py --title "视频文件蒸馏" --space-id <id>`
4. 先校验再创建：
   ```bash
   python doc/create_doc.py --title "<视频标题>" --space-id <id> --parent-id <文件夹id> \
     --content-file work/<BV>_P<n>/notes.md --dry-run
   python doc/create_doc.py --title "<视频标题>" --space-id <id> --parent-id <文件夹id> \
     --content-file work/<BV>_P<n>/notes.md
   ```
5. 把返回的 `KS_USER_REPLY` 原样转给用户，并补一行「已存至 …」

坑：
- 列子目录的参数是 `--parent-node-id`，不是 `--parent-id`
- `notes.md` 是纯 Markdown 列表，可直接创建；一旦版式里加了 GFM 表格，改成「先建骨架再逐表插入」，否则大文档容易超时

## 4. 目录与缓存

- 素材默认落在 `<skill>/scripts/work/<BV>_P<n>/`，可用环境变量 `KB_WORK_DIR` 指到别处
- 转写分片缓存是 `chunks/chunk_XXX.wav.<model>.json`，**别删**：同视频重跑能省 90% 时间
- `work/` 会堆视频文件（每个几十 MB），定期清理旧的 `<BV>_P<n>` 目录即可，不影响技能

## 5. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `SESSDATA已过期，请更新Cookie` | Cookie 失效 | 重新取 SESSDATA；没有也能跑，走本地转写 |
| 转写卡住超过 10 分钟 | 旧版服务单进程串行 | 确认 `/ping` 里 `workers` 有值；否则重启服务 |
| 画面文字为空 | 纯人像/纯黑画面 | 正常，不是故障，标 `coverage.missing` |
| 分享的第 N 集出成第 1 集 | 链接缺 `?p=N` | 补参数；核回参 `page` |
| 时间戳全 0 | 字幕没有时间轴 | 该视频无字幕轨，走转写 |
| 远程取帧报 `Invalid argument ... returned 22` | ffmpeg 收到了非法的 `protocol_whitelist` 选项 | 已去掉该选项；升级脚本即可 |
| 远程取帧 403 | CDN 要求 Referer/UA 头 | 脚本已带 `Referer` + `User-Agent`；仍失败会自动回退本地下载 |
| 远程取帧拿不到时长 | `.m4s` 后缀 ffmpeg 猜不出格式 | 显式 `format="mp4"`（脚本已处理）；仍失败靠 `duration` 兜底采样 |
| 下载卡住不动 | 单连接被 CDN 限速 | 默认已走 4/6 路并发；`--dlparts=1` 可退回单连接排障 |

## 站外链接与本地文件（yt-dlp 通道）

B站走原生接口，其余链接走 `yt_dlp`（Python 模块调用，非 CLI，避免 PATH 问题）。

**核心设计：不依赖 ffmpeg。** 本机通常没有 ffmpeg CLI，所以：
- 有 progressive（音视频同体的 mp4）→ 只下一次，转写与抽帧共用；
- 全 DASH（如 YouTube）→ 分别下「音频」给 whisper、「≤480p 视频」给 OCR。本来就各需一份，不需要合并。

**字幕优先级**：站点人工字幕 > 站点自动字幕 > 本地转写。字幕用 `yt-dlp --skip-download --write-subs` 拿到 json3/vtt/srt 后自行解析（直链常带签名，直接 curl 会 403）。

**常见故障对照**

| 现象 | 原因 | 处理 |
|---|---|---|
| `解析失败：... login ... cookies` | 站点要求登录 | 让用户提供浏览器 Cookie；或改本地文件 |
| `未找到可下载的视频/音频格式` | 站点改版、yt-dlp 过期 | `pip install -U yt-dlp` |
| 字幕为空但确实有 | 语种不在 `zh/en` 白名单 | 改 `ytDlpSubtitles` 里的 `--sub-langs` |
| 画面文字 0 块 | 视频本身无文字（纯人像/实拍） | 正常，已标注「画面文字缺失」，只出音频部分 |
| 纯视频文件报「不含音轨」 | 用了 DASH 视频流当输入 | 正常降级；用合体文件或另给音频 |
