# 发布指南 · 万链凝识 (vidLinkDistill)

两条路可以走，互不冲突：

| 渠道 | 面向 | 说明 |
|---|---|---|
| **GitHub 开源** | 开发者 / 通用 agent 用户 | 完整源码 + 版本历史 + Issue |
| **WorkBuddy 技能市场** | WorkBuddy 用户 | 传 zip，可被搜索到、被安装 |

本文件是仓库内随代码走的版本。**上架时的逐字段填写表**在各自的资料文件夹里，不在仓库里。

---

## 一、GitHub 发布

### 1. 必须准备的材料

| 文件 | 作用 | 必需 |
|---|---|---|
| `SKILL.md` | 技能主文件，agent 靠它决定何时加载 | ✅ |
| `README.md` / `README_EN.md` | 项目门面（中文 + 英文） | ✅ |
| `LICENSE` | 开源许可证（本仓库用 MIT） | ✅ |
| `requirements.txt` | Python 依赖 | ✅ |
| `.gitignore` | 排除素材 / 模型 / 缓存（否则仓库几十 GB） | ✅ |
| `references/` | 细则文档（notes schema、运行时） | 建议 |
| `scripts/` | 可执行脚本 | 按需 |
| `examples/` | 一份真实输出样例 | 强烈建议 |
| `CHANGELOG.md` | 版本变更记录 | ✅ |
| `CONTRIBUTING.md` | 贡献指南与不变量清单 | ✅ |
| `.github/` | Issue 模板 + CI | ✅ |

**绝对不能进仓库**：`work/`（视频、音频、切片）、`chunks/` 转写缓存、`.sessdata` 或任何 Cookie、`__pycache__`。

### 2. 发布步骤

```bash
cd vidLinkDistill
git init
git add .
git status                 # 确认没有 work/ 与 *.wav / *.mp4
git commit -m "feat: 万链凝识 vidLinkDistill v1.4.0"

git branch -M main
git remote add origin https://github.com/wumengbing1030-lgtm/vidLinkDistill.git
git push -u origin main
```

打 tag 发版本：

```bash
git tag -a v1.4.0 -m "v1.4.0 首次发布"
git push origin v1.4.0
```

GitHub 仓库页 → Releases → Draft a new release → 选 `v1.4.0` → 标题 `v1.4.0 · 首次发布` → 正文粘贴 Release 稿 → 把 zip 作为附件上传（非技术用户可直接下载）。

### 3. 仓库设置（建仓库时）

- Repository name：`vidLinkDistill`
- Description：一句话说明，≤350 字符
- Visibility：Public
- 初始化时**不要**勾选自动生成 README / LICENSE / .gitignore（本包自带，勾了会冲突）
- Topics：`agent-skill` `skill` `bilibili` `youtube` `video-summary` `video-transcription` `whisper` `ocr` `knowledge-notes` `knowledge-management`
- Social preview：1280×640，图标放到深色底上居中

### 4. README 怎么写才有人用

按这个顺序，别写成散文：

1. **一句话说清它是什么**（把视频链接变成结构化笔记）
2. **它解决什么具体问题**（痛点要具体到"第几分钟"这种程度）
3. **和相近项目的区别**（表格，避免被误认为另一个 cangjie）
4. **安装**（三行命令，能复制）
5. **用法**（对话式 + 命令行两种）
6. **输出长什么样**（贴真实片段，不要示意图）
7. **性能**（真实数字，注明机器配置）
8. **已知限制**（同音字、画面质量、平台）
9. **合规与 License**

---

## 二、WorkBuddy 技能市场上架

### 1. 打包规范

平台校验很严格，以下任一条不符都会报错：

| 检查项 | 要求 |
|---|---|
| 压缩格式 | **只接受 `.zip`** |
| 体积 | **≤ 3 MB** |
| 包结构 | `SKILL.md` 必须在**压缩包根目录**，不能多套一层文件夹 |
| frontmatter 8 必填 | `name` / `display_name` / `display_name_en` / `description` / `description_zh` / `description_en` / `version` / `author` |
| `name` | 必须与目录名一致 |
| `version` | 形如 `1.0.0` |
| `examples_zh` / `examples_en` | 各最多 3 条 |
| 展示名称 | 付费资产的 `display_name` 仅支持中英文、数字和 `-`，**不能含空格或特殊字符** |
| 杂质 | 不能混入 `__pycache__`、`.pyc`、测试素材 |

自检：

```bash
unzip -l vidLinkDistill_v1.4.0.zip | head -20     # 确认 SKILL.md 在根
unzip -p vidLinkDistill_v1.4.0.zip SKILL.md | head -25
```

### 2. 上架流程

1. 打开 WorkBuddy 开放平台：<https://open.workbuddy.cn/>
2. 首次入驻做**开发者认证**（个人认证需实名 + 人脸识别）
3. 左侧【发布管理】→【**技能**】
   - ⚠️ 别点成「专家」：两者校验规则不同，传错会报「未找到 SKILL.md」
4. 【创建】→ 上传 `.zip` → 平台自动开包解析并生成技能 ID
5. 提交审核
6. **审核通过后还要自己再点一次【发布】**，否则不会出现在市场里
7. 回到 WorkBuddy 搜索技能名，能搜到即上架成功

### 3. 名称与付费的两条硬规则（实测）

- **`name` 建议小写字母 + 数字 + 连字符**（社区规范如 `generate-report`）。本技能名 `vidLinkDistill` 含大写字母，若平台报"名称不合法"，改用小写包 `vidlink-distill` 重传（内容一致，只差 `name` 一行）。
- **免费资产不能转付费**。想收费必须一开始就说清；计费方式发布上架后不可更改。

### 4. 差异化（写进市场介绍）

市场上已有 `bilibili-video-summary`（B站视频总结 + 事实核查）。本技能的差异点：

- **画面文字**：关键帧 OCR，PPT / 板书 / 公式 / 表格能进笔记
- **手机排版**：分级编号 + 内容地图，不是给电脑看的长文
- **双版本**：每条都有「原版」和「初中生能懂」两版
- **时间戳溯源**：每条都能追回第几分钟
- **多集批量**：合集 / 多 P / 整系列自动出总览
- **本地运行**：视频不上传第三方

### 5. 版本迭代

改完重新打包，版本号 +0.0.1 或 +0.1.0，在【发布管理】里选「更新版本」重新上传，同样的审核流程。

用户反馈驱动迭代，别一次想做全。真实反馈逼出来的修正，才是技能值钱的地方。
