# 万链凝识 · vidLinkDistill

把一条**视频链接**一键蒸馏成**手机能读的结构化知识笔记**：带时间戳的字幕 + 关键帧画面文字（PPT / 板书 / 公式 / 表格）融合，剔除广告与口水词，知识点分级编号，每条同时给出「忠于原文的提炼」和「初中生能懂的通俗解读」，并附一份思维导图大纲。

> 核心主张：**每条结论都能追回一个时间点，每段专业内容都有一个说人话的版本，全篇有一个一眼能看懂的骨架。**

```
输入：一条 B 站链接（可选 SESSDATA）
输出：一份笔记 —— 内容地图 / 分级知识点 / 双版本表述 / 思维导图大纲
```

## 它解决什么问题

看一个 55 分钟的技术访谈，真正的损失不是"没时间看完"，而是：

- 讲得好的三句话淹在五千字口水里，回头找不到在第几分钟
- 画面上的架构图、公式、对比表，纯字幕工具一个字都拿不到
- 转写出来的"铁不到盐"其实是"吃不到盐"，同音字错了没人告诉你
- 总结给你十句漂亮话，但你没看懂——因为它假设你已经是同行

这个技能把这四件事一起处理：**时间戳溯源、画面文字 OCR、音画交叉校正、双版本表述**。

## 与相近技能的区别

| 技能 | 产出 | 适合 |
|---|---|---|
| **万链凝识 vidLinkDistill（本项目）** | 一份可反复读的**分层笔记** | 想读懂、想回查、想入库检索 |
| [cangjie-skill](https://github.com/) | 一组可被 agent 调用的**可执行技能** | 想把方法论变成能力 |
| book-distill | 书 → 知识库 + 技能卡 | 想把书变成可问的库 |
| 普通视频总结工具 | 一段摘要 | 只想知道讲了啥 |

**互补不冲突**：要"能力"用仓颉，要"读懂"用本技能。

## 安装

需要 Python ≥ 3.10 与 Node ≥ 18。

```bash
git clone https://github.com/wumengbing1030-lgtm/vidLinkDistill.git
cd vidLinkDistill
pip install -r requirements.txt          # faster-whisper / rapidocr-onnxruntime / av / numpy
```

把整个目录放进你的 agent 技能目录：

```bash
# WorkBuddy（用户级，所有项目可用）
cp -r vidLinkDistill ~/.workbuddy/skills/

# 其他支持 SKILL.md 的 agent（Claude Code / Codex / Cursor 等）
cp -r vidLinkDistill ~/.claude/skills/
```

首次运行会下载 whisper-small 模型（约 480MB），只有第一次慢。

## 支持的来源

不只 B 站。同一个流水线吃三种输入，输出格式完全一致：

| 来源 | 怎么用 | 实测 |
|---|---|---|
| **B站** | 贴链接或整段分享文案，`?p=3` 分 P 自动识别 | ✅ 一路跑通，配 SESSDATA 秒级出字幕 |
| **任意站点** | 直接贴链接，内部走 yt-dlp（内置 1754 个站点解析器） | ✅ YouTube 实测通过：自动下 480p 画面 + 音频 + 站点字幕 |
| **本地文件** | `--file="D:/v.mp4"`，可外挂 `--sub=x.srt` | ✅ mp4/m4a/webm/mkv 均可，纯音频或纯视频也能跑 |

站点实测情况（客观标注，别当成全都能用）：

| 站点 | 状态 |
|---|---|
| YouTube / Vimeo / Dailymotion / TED | ✅ 稳定，一般还有现成字幕 |
| 西瓜视频 / 微博视频 | ✅ 通常可解析，无字幕则本地转写 |
| 抖音 / TikTok | ⚠️ 多数视频需要浏览器 Cookie，公开视频偶尔能直接拿 |
| 小红书 | ⚠️ 同上，需 Cookie，且常有防盗链 |
| 腾讯视频 / 爱奇艺 / 优酷 / 芒果 | ❌ 会员片是 DRM 加密，任何工具都解不开；只有免费片段偶尔可用 |
| 视频号 | ❌ 无公开接口，请先录屏或导出后用 `--file=` 走本地模式 |

**兜底方案永远有效**：不管哪个站，只要能下载到文件（浏览器插件、录屏、官方导出），`--file=` 一定跑得通——平台差异只影响「怎么拿到文件」，不影响后面的转写、OCR、清洗、笔记成稿。

## 用法

### 在对话里

```
把这条视频蒸馏成笔记 https://www.bilibili.com/video/BV1xxxxxxxxx
SESSDATA=xxxx（可选，有官方字幕时零错字）
```

### 命令行

```bash
# 1. 起两个常驻服务（各占一个终端）
python scripts/transcribe_daemon.py     # 127.0.0.1:8766
python scripts/ocr_daemon.py            # 127.0.0.1:8767
# Windows 也可直接跑 scripts/start_daemons.bat

# 2. 采集：字幕/转写 + 关键帧 OCR，生成素材包
node scripts/kb.js "https://www.bilibili.com/video/BV1xxxxxxxxx" --frames=20
node scripts/kb.js "https://www.youtube.com/watch?v=xxxxxxxxxxx"   # 站外
node scripts/kb.js --file="D:/videos/talk.mp4" --sub="D:/videos/talk.srt"  # 本地

# 3. 按 references/notes-schema.md 写 work/<BV>_P1/notes.json

# 4. 质量闸门（不 PASS 不许交付）
node scripts/check_notes.js work/BV1xxxxxxxxx_P1/notes.json \
  --digest=work/BV1xxxxxxxxx_P1/digest.md

# 5. 渲染成成品
node scripts/render.js work/BV1xxxxxxxxx_P1/notes.json --rag
```

### 一整套视频（多选集 / 合集）

B站一条链接下挂着好几个选集，或者你要处理的是同一门课的一串链接时，不要一集一集手动跑：

```bash
# 1) 先看清单与耗时预估，不下载
node scripts/kb-batch.js --url="https://www.bilibili.com/video/BV1xxxxxxxxx" --list

# 2) 逐集采集素材（默认只取口播；要 PPT/公式再加 --ocr=on）
node scripts/kb-batch.js --url="https://www.bilibili.com/video/BV1xxxxxxxxx" --sessdata=xxx

# 3) 每集写完 notes.json、跑完 render.js 之后，重建总览
node scripts/kb-batch.js --url="https://www.bilibili.com/video/BV1xxxxxxxxx" --index
```

三种输入都行：`--url=`（一个链接自动展开全部分P/合集）、`--urls=u1,u2,u3`、`--urls-file=list.txt`（每行一条，`#` 注释）。

| 参数 | 说明 | 默认 |
|---|---|---|
| `--pages=all\|1-5\|1,3,7` | 选集范围 | all |
| `--list` | 只出清单，不下载不采集 | — |
| `--index` | 只重建 `out/<系列>/index.md` | — |
| `--ocr=off\|on` | 批量默认关画面识别，快数倍且不下载视频 | off |
| `--name=系列名` | 标题接口被限流时用来命名 | 自动 |
| `--max-minutes=90` | 超过该时长的集直接跳过 | 0（不限） |
| `--force` | 忽略已有成果强制重做 | 断点续跑 |

交付物在 `out/<系列名>/`：`index.md`（状态表 + 各集主题索引 + 跨集主线）+ `P01-xxx.md` 等各集成品。

> 注意：批量只负责「采集素材 + 汇总」。**每一集仍要走萃取 → 写 notes.json → 闸门 → 渲染**，索引里的 `📦 素材待提炼` 就是还没写笔记的集。

### 常用参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `--sessdata=xxx` | 有则走官方字幕，秒级零错字 | 无 |
| `--frames=N` | 关键帧上限，讲授类给 24–36，纯口播给 12 | 20 |
| `--budget=N` | 素材包字数上限，长视频给 30000 | 15000 |
| `--from=N` | 只处理 N 秒之后（长视频断点续跑） | 0 |
| `--model=size` | whisper 模型（tiny/base/small） | small |
| `--file=路径` | 用本地文件代替链接（万能兜底） | 无 |
| `--sub=路径` | 外挂字幕（srt/vtt），比转写准 | 无 |
| `--title=名称` | 自定义标题（决定工作目录名） | 文件名/站点标题 |
| `--lite` | 精简模式，只留主干 | 完整 |
| `--ocr=off` | 跳过画面识别，只取口播（快数倍，不下载视频） | on |
| `--remote=off` | 画面识别不用远程流式取帧，强制下载本地视频 | 远程取帧 |
| `--dlparts=N` | 下载并发分段数；`--dlparts=1` 退回单连接（排障用） | 音频 4 / 视频 6 |
| `--html`（render.js） | 额外生成网页版笔记，自包含可分享 | 仅 Markdown |

## 输出长什么样

```markdown
## 内容地图

共 7 个主题 / 23 条知识点

| # | 主题 | 时间段 | 条数 |
|---|------|--------|------|
| 1 | 核心心智模型：带 AI 助手＝带工程团队 | 0:00–4:47 | 4 |

## 关键结论速览

- **1** 敢不敢把活交出去，决定你能同时开几条线。

## 1. 核心心智模型：带 AI 助手＝带工程团队

`0:00–4:47`　·　4 条

> **本段小结**　并行度＝信任度。不信任，就只能自己盯着写每一个 prompt。

### 1.1　⭐ ✅

**原话**　她直接把带 agent 类比成做工程经理：如果我不信任团队里的工程师，我的运作方式就会完全不同——信任程度决定了我能并行多少条线。

⏱ **音频时间**　`1:32`　·　音频

**简易理解**　就像你敢不敢把事情交给别人：敢放手，就能同时派好几拨人干活；不敢，就只能自己一件件做。
```

网页版（`--html`）额外产出 `notes.html`：移动端优先、深浅色自适应、核心知识点高亮、目录可点，自包含单文件可直接转发。

**新版式（v1.3.0）**：每个知识点都有「小标题」；内容地图表格在「条数」后追加「小标题」列；关键结论速览改成卡片；原话用淡粉底方框、简易理解用淡蓝底方框；思维导图大纲改成括号树（`◆` → `（1）` → `（1.1）`），括号内即记忆顺序。

完整样例见 [`examples/`](examples/)。

## 性能

在 16 核 CPU / 32GB 的机器上实测：

| 场景 | 耗时 |
|---|---|
| 55 分钟视频 | **约 3 分钟**（转写与 OCR 并行） |
| 3 分钟视频 | 约 50 秒（含下载） |
| 同视频重跑 | 约 10 秒（分片缓存命中） |
| 有官方字幕的短视频 | 通常 < 40 秒 |

下载与取帧（67 分钟视频实测）：

| 环节 | 单连接 | 优化后 | 变化 |
|---|---|---|---|
| 音频下载 32MB | 38 秒 | **9.8 秒**（4 路并发） | 快 3.8 倍 |
| 画面识别 | 需先下 32MB 视频 | **直接远程流式取帧，0 字节下载** | 少一次整段下载 |

转写走多进程池（4 进程 × 4 线程）。**加并发不会更快**——实测 8/16 线程单片反而更慢（超线程反噬），`BatchedInferencePipeline` 在 CPU 上比普通推理慢 60%。4×4 已是这台机器的上限。

## 目录结构

```
vidLinkDistill/
├── SKILL.md                    # 技能主文件（agent 读这个）
├── requirements.txt
├── references/
│   ├── notes-schema.md         # notes.json 结构与写作红线
│   └── runtime.md              # 服务启动、入库、故障排查
├── scripts/
│   ├── kb.js                   # 采集：字幕/转写 + OCR → digest.md
│   ├── check_notes.js          # 质量闸门（客观缺陷硬校验）
│   ├── render.js               # 渲染成手机友好的 Markdown
│   ├── split_audio.py          # 音频切分（16k 单声道）
│   ├── transcribe_daemon.py    # 转写常驻服务（多进程池）
│   ├── ocr_daemon.py           # OCR 常驻服务（抽帧 + 去重）
│   └── start_daemons.bat       # Windows 一键起服务
└── examples/
    └── notes.sample.md
```

## 设计要点

**为什么脚本 + agent 分工**：采集是确定性的活（下载、解码、OCR、切片），交给脚本；蒸馏是判断的活（什么值得写、怎么讲人话），交给模型。两者混在一起，任一半出问题都会整体失效。

**为什么要有质量闸门**：模型写笔记最常见的失败不是"写得不好"，而是"悄悄偷懒"——缺时间戳、通俗解读写成黑话、同一句话换个说法重复三遍。这些都是机器能判的客观缺陷，用 `check_notes.js` 直接拦，比在提示词里反复叮嘱可靠。

**为什么保留 rejected.md**：淘汰的知识点要能解释为什么淘汰。用户问「这条为什么没写」，能立刻拿出 V1/V2/V3 的判定理由，而不是"我觉得不重要"。

## 已知限制

- **需要登录/付费的内容拿不到**：DRM 加密（各家长视频会员）与私密内容无法处理，这不是实现问题。
- **站外链接依赖 yt-dlp 的时效性**：站点改版后可能暂时失效，`pip install -U yt-dlp` 通常能修好。

- **同音字**：本地转写无法彻底修正，画面烧录字幕能校正一部分。专有名词不确定会标 📌，请自行核对。
- **画面文字**：纯人像、纯黑屏、动态视频画面识别质量有限，结果为空是正常的。
- **语言**：中文最佳，英文可用（small 模型对人名/产品名易错），其他语种未验证。
- **平台**：字幕接口针对 Bilibili；换平台需要改 `kb.js` 的解析部分，其余链路通用。

## 合规

仅供个人学习与内容整理。请遵守视频平台的服务条款与著作权规定，不要用于二次分发、搬运或商业用途。工具本身不下载、不转存、不再分发视频文件。

## License

MIT。见 [LICENSE](LICENSE)。
