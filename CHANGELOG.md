# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [1.4.0] — 2026-11-19

### Added
- 品牌更名：**万链凝识**（vidLinkDistill），中文名突出「视频链接一键蒸馏」的定位
- `description` / `description_zh` / `description_en` 重写：补齐触发词（含「万链凝识」「一键蒸馏这个链接」），并明确写出**不适用范围**（一句话摘要 / 编译成可执行技能 / 下载二次分发）
- `category: productivity-tools` 字段，贴合平台分类体系
- `README_EN.md` 英文门面，GitHub 国际化读者可直接阅读
- `CHANGELOG.md`、`CONTRIBUTING.md`、GitHub Issue 模板（Bug / Feature）
- GitHub Actions CI：Python / Node 语法检查 + 打包结构自检（SKILL.md 在根、无 `__pycache__`、体积 ≤3 MB）
- 512×512 技能图标

### Changed
- `display_name` → `万链凝识`，`display_name_en` → `VidLink Distill`
- `version` → `1.4.0`
- 包名 / 目录名 / frontmatter `name` 统一为 `vidLinkDistill`（另备小写包 `vidlink-distill` 供平台校验不通过时切换）
- README 顶部定位句改为「视频链接一键蒸馏」，强调输入是**链接**
- 仓库 `docs/PUBLISH.md` 补齐 WorkBuddy 市场「名称不能含空格/特殊字符」「免费资产不能转付费」两条实测规则

## [1.3.0]

### Added
- 每个知识点新增「小标题」（≤14 字，同主题内不重复），由质量闸门强制校验
- 内容地图表格追加「小标题」列；关键结论速览改为卡片
- 原话用淡粉底方框、简易理解用淡蓝底方框；思维导图大纲改为括号树（`◆` → `（1）` → `（1.1）`）

## [1.2.0]

### Added
- 批量模式 `kb-batch.js`：支持 `--url=` 自动展开分 P / 合集、`--urls=`、`--urls-file=`
- 整集总览 `out/<系列名>/index.md`：状态表 + 各集主题索引 + 跨集主线
- `--list`（只出清单与耗时预估）、`--index`（只重建总览）、`--max-minutes=`、`--force`

### Changed
- 批量模式默认 `--ocr=off`，画面识别改为按需开启

## [1.1.0]

### Added
- 站外链接通道：yt-dlp 通用解析（1,754 站点）
- 本地文件入口 `--file=` + 外挂字幕 `--sub=`
- 画面识别改为远程流式取帧，长视频不再整段下载
- 质量闸门 `check_notes.js`：数字归一化比较规则

## [1.0.0]

### Added
- 首版：B站链接采集（字幕 / 本地转写）+ 关键帧 OCR
- 阶段 0–5 流水线与断点续跑（`PIPELINE_STATE.md`）
- 三层验证（V1 跨段佐证 / V2 可迁移 / V3 非常识）+ `rejected.md` 审计
- 分层笔记输出（内容地图 / 主题 / 知识点 / 双版本表述）
