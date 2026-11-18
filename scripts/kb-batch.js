#!/usr/bin/env node
/**
 * kb-batch.js — 视频集（多 P / 多链接）批量蒸馏编排器
 *
 * 它负责「机械部分」：展开选集、逐集采集素材、汇总索引。
 * 「提炼成笔记」由执行者（agent）逐集读素材、写 notes.json、跑 render.js 完成。
 *
 * 输入三选一：
 *   --url=<B站链接>        一个链接，自动展开该视频下的全部选集（分P）
 *   --urls=<u1,u2,...>     多个链接（不同 BV 也行，按给定顺序当作一套）
 *   --urls-file=<路径>     文件，每行一个链接（# 开头为注释）
 *
 * 动作（默认 collect）：
 *   --list                 只出清单与耗时预估，不下载、不采集
 *   --collect              逐集采集素材，落到 work/<BV>_P<n>/
 *   --index                只重建 out/<系列>/index.md（扫描已有产物）
 *
 * 参数：
 *   --pages=all|1-5|1,3,7  选集范围（默认 all）
 *   --sessdata=<值>        有它才能看到 B 站官方/自动字幕（强烈建议）
 *   --ocr=off|on           批量默认 off（只靠口播，快数倍）；需要 PPT/公式时开 on
 *   --frames=40            开 OCR 时的抽帧上限
 *   --model=small          无字幕时的转写模型
 *   --name=<系列名>        自定义系列标题（多链接时建议给）
 *   --out=<目录>           交付目录（默认 out/<系列slug>）
 *   --force                忽略已有成果强制重做
 *   --max-minutes=90       保护：单集超过该时长则跳过（0 = 不限）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const ROOT = process.env.KB_WORK_DIR || __dirname;
const NODE = process.execPath;
const KB = path.join(__dirname, 'kb.js');

/* ---------------------------------------------------------------- 小工具 */
const pad2 = n => String(n).padStart(2, '0');
function ts(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => process.stderr.write(m + '\n');

function getJSON(url, sessdata, tries = 3) {
  const headers = {
    'Referer': 'https://www.bilibili.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  };
  if (sessdata) headers.Cookie = `SESSDATA=${sessdata}`;
  return new Promise((resolve, reject) => {
    const attempt = n => {
      https.get(url, { headers }, res => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => {
          if (/^\s*</.test(buf) || /"code":-(412|352|799)/.test(buf)) {
            if (n < tries) return setTimeout(() => attempt(n + 1), 4000 * n);
            return reject(new Error('B站接口触发风控，请隔几分钟再试，或加 --sessdata'));
          }
          try { resolve(JSON.parse(buf)); }
          catch (e) { reject(new Error('接口返回非 JSON：' + buf.slice(0, 100))); }
        });
      }).on('error', e => (n < tries ? setTimeout(() => attempt(n + 1), 2000 * n) : reject(e)));
    };
    attempt(1);
  });
}

function cleanShareText(input) {
  const s = String(input || '').trim();
  const m = s.match(/https?:\/\/[^\s，。、）)】"'|]+/);
  if (m) return m[0];
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return 'https://www.bilibili.com/video/' + bv[0];
  const av = s.match(/av(\d+)/i);
  if (av) return 'https://www.bilibili.com/video/av' + av[1];
  return s;
}
function extractIds(url) {
  const bv = String(url).match(/BV[0-9A-Za-z]{10}/);
  const av = String(url).match(/\/av(\d+)/i) || String(url).match(/[?&]aid=(\d+)/);
  return { bvid: bv ? bv[0] : null, aid: av ? av[1] : null };
}
function slugify(s, max = 40) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'series';
}
function parseDur(s) {
  if (!s) return 0;
  const p = String(s).split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return 0;
}

/* ---------------------------------------------------------------- 参数 */
function parseArgs(argv) {
  const o = {
    url: '', urls: '', urlsFile: '', action: 'collect', pages: 'all', sessdata: '',
    ocr: 'off', frames: 40, model: 'small', name: '', out: '',
    force: false, maxMinutes: 0, budget: 15000
  };
  for (const a of argv) {
    if (a.startsWith('--url=')) o.url = a.slice(6);
    else if (a.startsWith('--urls=')) o.urls = a.slice(7);
    else if (a.startsWith('--urls-file=')) o.urlsFile = a.slice(12).replace(/^["']|["']$/g, '');
    else if (a === '--list') o.action = 'list';
    else if (a === '--index') o.action = 'index';
    else if (a === '--collect') o.action = 'collect';
    else if (a === '--force') o.force = true;
    else if (a.startsWith('--pages=')) o.pages = a.slice(8).trim();
    else if (a.startsWith('--sessdata=')) o.sessdata = a.slice(11).trim();
    else if (a.startsWith('--ocr=')) o.ocr = /^(off|no|0|false)$/i.test(a.slice(6)) ? 'off' : 'on';
    else if (a.startsWith('--frames=')) o.frames = parseInt(a.slice(9), 10) || 40;
    else if (a.startsWith('--model=')) o.model = a.slice(8);
    else if (a.startsWith('--name=')) o.name = a.slice(7).trim();
    else if (a.startsWith('--out=')) o.out = a.slice(6).replace(/^["']|["']$/g, '');
    else if (a.startsWith('--max-minutes=')) o.maxMinutes = parseInt(a.slice(14), 10) || 0;
    else if (a.startsWith('--budget=')) o.budget = parseInt(a.slice(9), 10) || 15000;
  }
  return o;
}

/* ---------------------------------------------------------------- 选集解析 */
function parsePageSpec(spec, total) {
  if (!spec || spec === 'all') return Array.from({ length: total }, (_, i) => i + 1);
  const out = new Set();
  for (const seg of String(spec).split(',')) {
    const s = seg.trim();
    if (!s) continue;
    const r = s.match(/^(\d+)\s*-\s*(\d+)$/);
    if (r) {
      const a = Math.max(1, parseInt(r[1], 10)), b = Math.min(total, parseInt(r[2], 10));
      for (let i = a; i <= b; i++) out.add(i);
    } else if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      if (n >= 1 && n <= total) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

async function expandBili(url, sessdata) {
  const { bvid, aid } = extractIds(url);
  if (!bvid && !aid) throw new Error('链接里没有 BV/av 号：' + url);
  const key = bvid ? `bvid=${bvid}` : `aid=${aid}`;

  let pages = [];
  const pl = await getJSON(`https://api.bilibili.com/x/player/pagelist?${key}`, sessdata).catch(e => {
    log('  ! 分P列表获取失败（' + e.message + '），按单集处理');
    return null;
  });
  if (pl && pl.code === 0 && Array.isArray(pl.data)) pages = pl.data;

  let seriesTitle = '', owner = '', season = null;
  await sleep(700);
  const v = await getJSON(`https://api.bilibili.com/x/web-interface/view?${key}`, sessdata, 2).catch(() => null);
  if (v && v.code === 0 && v.data) {
    seriesTitle = v.data.title || '';
    owner = (v.data.owner && v.data.owner.name) || '';
    // 合集（多个独立 BV 的系列）：分P 只有 1 集时才用它
    const us = v.data.ugc_season;
    if (us && Array.isArray(us.sections)) {
      const eps = [];
      for (const sec of us.sections) {
        for (const e of (sec.episodes || [])) {
          if (e.bvid) eps.push({
            bvid: e.bvid,
            aid: e.aid || null,
            cid: e.cid || null,
            page: 1,
            part: (e.title || e.bvid).trim(),
            duration: e.duration || 0,
            url: `https://www.bilibili.com/video/${e.bvid}`
          });
        }
      }
      if (eps.length > 1) season = { title: us.title || seriesTitle, episodes: eps };
    }
  } else {
    log('  · 标题接口被限流，系列名改用分P名（可用 --name= 指定）');
  }

  // 合集优先：一个链接指向「合集里的某一集」时，要的是整个合集
  if (season && pages.length <= 1) {
    log(`  · 识别为合集《${season.title}》，共 ${season.episodes.length} 集`);
    return { bvid, aid, seriesTitle: season.title, owner, episodes: season.episodes };
  }

  if (!pages.length) {
    pages = [{ page: 1, cid: null, duration: (v && v.data && v.data.duration) || 0, part: seriesTitle || 'P1' }];
  }

  // 标题拿不到就用分P名兜底：单集时它就是标题，多集时第一集的章节名也比 BV 号有信息量
  if (!seriesTitle) {
    const first = (pages[0] && pages[0].part) ? pages[0].part.trim() : '';
    seriesTitle = first
      ? (pages.length > 1 ? `${first} 等 ${pages.length} 集` : first)
      : (bvid || 'av' + aid);
  }

  return {
    bvid, aid,
    seriesTitle,
    owner,
    episodes: pages.map((p, i) => {
      const no = p.page || i + 1;
      return {
        page: no,
        cid: p.cid || null,
        part: (p.part || `P${no}`).trim(),
        duration: p.duration || 0,
        bvid,
        url: `https://www.bilibili.com/video/${bvid || 'av' + aid}?p=${no}`
      };
    })
  };
}

async function resolveSeries(args) {
  const inputs = [];
  if (args.url) inputs.push(args.url);
  if (args.urls) inputs.push(...args.urls.split(/[\s,，]+/).filter(Boolean));
  if (args.urlsFile) {
    const txt = fs.readFileSync(args.urlsFile, 'utf8');
    inputs.push(...txt.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#')));
  }
  if (!inputs.length) throw new Error('缺少输入：--url= / --urls= / --urls-file=');

  const groups = [];
  for (const raw of inputs) {
    const u = cleanShareText(raw);
    log('· 解析 ' + u);
    const g = await expandBili(u, args.sessdata);
    log(`  → ${g.episodes.length} 集：${g.seriesTitle}`);
    groups.push(g);
    await sleep(1200);
  }

  const multiSrc = groups.length > 1;
  const episodes = [];
  for (const g of groups) {
    for (const ep of g.episodes) {
      episodes.push({
        ...ep,
        seq: episodes.length + 1,        // 展示与文件名的全局序号（合集里 page 恒为 1，不能用作序号）
        partLabel: multiSrc ? `${g.seriesTitle} · ${ep.part}` : ep.part,
        owner: g.owner
      });
    }
  }
  const name = args.name || (groups.length === 1 ? groups[0].seriesTitle : `多源合集-${groups.length}个视频`);
  return { name, owner: (groups.find(g => g.owner) || {}).owner || '', episodes };
}

/* ---------------------------------------------------------------- 采集 */
function runKb(ep, args) {
  return new Promise(resolve => {
    const argv = [KB, `--url=${ep.url}`, `--model=${args.model}`, `--frames=${args.frames}`, `--ocr=${args.ocr}`, `--budget=${args.budget}`];
    if (args.sessdata) argv.push(`--sessdata=${args.sessdata}`);
    const p = spawn(NODE, argv, { env: { ...process.env, PYTHONIOENCODING: 'utf-8', KB_WORK_DIR: ROOT } });
    let out = '', err = '';
    p.stdout.on('data', d => {
      const s = String(d);
      out += s;
      // 把子进程的进度/警告实时转出来，否则批量跑几十分钟一片安静
      for (const line of s.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const j = JSON.parse(t);
          if (j.progress === 'split') log('    · 音频切片中');
          else if (j.progress === 'transcribe_start') log(`    · 开始转写：${j.pending} 片待跑（缓存命中 ${j.cached}/${j.total}）`);
          else if (j.progress === 'transcribe') log(`    · 转写完成 ${j.done}/${j.total}，耗时 ${j.sec}s`);
          else if (j.warn) log('    ! ' + j.warn);
        } catch (e) { /* 非 JSON 行忽略 */ }
      }
    });
    p.stderr.on('data', d => err += d);
    p.on('close', code => {
      let json = null;
      const i = out.lastIndexOf('\n{');
      const cand = i >= 0 ? out.slice(i + 1) : out;
      try { json = JSON.parse(cand); } catch (e) { /* 交给上层按失败处理 */ }
      resolve({ code, json, raw: out, stderr: err });
    });
  });
}

const workDirFor = ep => path.join(ROOT, 'work', `${ep.bvid || 'av'}_P${ep.page}`);

/** 一集的状态：done=已有成品笔记 / material=只有素材 / none=未处理 */
function epState(ep) {
  const d = workDirFor(ep);
  const notes = path.join(d, 'notes.md');
  const json = path.join(d, 'notes.json');
  const digest = path.join(d, 'digest.json');
  if (fs.existsSync(notes) && fs.statSync(notes).size > 300) return { state: 'done', notes, json: fs.existsSync(json) ? json : null };
  if (fs.existsSync(digest) && fs.statSync(digest).size > 200) return { state: 'material', notes: null, json: null, digest };
  return { state: 'none' };
}

/** 从成品笔记或素材里取「主题清单 + 信息源」 */
function summarize(ep) {
  const st = epState(ep);
  // 优先用 notes.json（结构最干净）
  if (st.state === 'done' && st.json) {
    try {
      const n = JSON.parse(fs.readFileSync(st.json, 'utf8'));
      const themes = (n.topics || []).map(t => ({ title: t.title, count: (t.items || []).length, subs: (t.items || []).map(it => String(it.title || '').trim()).filter(Boolean) }));
      return { ...st, themes, audio: (n.coverage && n.coverage.audio) || '', tldr: n.tldr || '', from: 'notes.json' };
    } catch (e) { /* 落到 md 解析 */ }
  }
  if (st.state === 'done' && st.notes) {
    const txt = fs.readFileSync(st.notes, 'utf8');
    const themes = [];
    let inMap = false;
    for (const line of txt.split(/\r?\n/)) {
      if (/^##\s+思维导图大纲/.test(line)) break;
      const m = line.match(/^##\s+\d+[.、]\s*(.+?)\s*$/);
      if (m) themes.push({ title: m[1].trim(), count: 0 });
    }
    const audioLine = (txt.match(/音频：([^　|]+)/) || [])[1] || '';
    const tldr = (txt.match(/一句话看懂\*\*\s*(.+)/) || [])[1] || '';
    return { ...st, themes, audio: audioLine, tldr: tldr.slice(0, 80), from: 'notes.md' };
  }
  if (st.state === 'material') {
    // 素材：只统计分块与信息源，主题尚未提炼
    let blocks = 0, audio = '';
    try {
      const d = JSON.parse(fs.readFileSync(st.digest, 'utf8'));
      blocks = (d.sections || []).length;
      audio = (d.audioInfo && d.audioInfo.source) || '';
    } catch (e) { /* 忽略 */ }
    return { ...st, themes: [], audio, tldr: '', blocks, from: 'digest.json' };
  }
  return { ...st, themes: [], audio: '', tldr: '', from: 'none' };
}

/* ---------------------------------------------------------------- 索引 */
function buildIndex(series, rows, args, outDir) {
  const total = rows.length;
  const totalDur = rows.reduce((a, r) => a + (r.duration || 0), 0);
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const doneN = rows.filter(r => r.state === 'done').length;
  const matN = rows.filter(r => r.state === 'material').length;
  const failN = rows.filter(r => r.state === 'failed').length;

  const badge = s => s === 'done' ? '✅ 成品' : s === 'material' ? '📦 素材待提炼' : s === 'failed' ? '❌ 失败' : '⬜ 未处理';

  const L = [];
  L.push(`# 《${series.name}》全集蒸馏总览`);
  L.push('');
  L.push(`> 来源：B站${series.owner ? ' · ' + series.owner : ''}　｜　共 ${total} 集　｜　总时长 ${ts(totalDur)}　｜　生成 ${stamp}`);
  L.push(`> 进度：成品 ${doneN} ／ 素材待提炼 ${matN}${failN ? ` ／ 失败 ${failN}` : ''}　｜　画面识别：${args.ocr === 'off' ? '关闭（仅口播）' : '开启'}`);
  L.push('');
  L.push('## 一、全集状态');
  L.push('');
  L.push('| # | 选集 | 时长 | 状态 | 信息源 | 主题数 | 笔记 |');
  L.push('|---|------|------|------|--------|--------|------|');
  for (const r of rows) {
    const st = r.state === 'failed' ? `❌ ${r.error || '失败'}` : badge(r.state);
    const th = r.themes.length ? String(r.themes.length) : (r.blocks ? `${r.blocks} 段素材` : '—');
    const link = r.file ? `[打开](./${path.basename(r.file)})` : '—';
    L.push(`| ${r.seq || r.page} | ${String(r.partLabel).replace(/\|/g, '／')} | ${ts(r.duration)} | ${st.replace(/\|/g, '／')} | ${(r.audio || '—').replace(/\|/g, '／')} | ${th} | ${link} |`);
  }
  L.push('');

  const cn = ['一','二','三','四','五'];
  let chap = 1;
  const withThemes = rows.filter(r => r.themes.length);
  if (withThemes.length) {
    L.push(`## ${cn[chap++]}、各集主题索引`);
    L.push('');
    for (const r of withThemes) {
      L.push(`### P${r.seq || r.page} ${r.partLabel}` + (r.file ? `　[打开笔记](./${path.basename(r.file)})` : ''));
      L.push('');
      if (r.tldr) L.push(`> ${r.tldr}`);
      if (r.tldr) L.push('');
      r.themes.forEach((t, i) => {
        L.push(`${i + 1}. ${t.title}${t.count ? `（${t.count} 条）` : ''}`);
        if (t.subs && t.subs.length) {
          L.push(`　　${t.subs.map(x => `▌${x}`).join('　')}`);
        }
      });
      L.push('');
    }
  }

  L.push(`## ${cn[chap++]}、跨集主线`);
  L.push('');
  L.push('> 由阅读全部单集笔记后补写：这个系列在讲什么、各集怎么递进、哪几集是主干、哪几集可跳。');
  L.push('');
  L.push('<!-- 补写 3–5 条，每条给结论 + 依据集数 -->');
  L.push('');
  L.push('---');
  L.push('');
  L.push('*单集笔记各自独立可读（含时间戳、通俗解读、思维导图大纲）。本总览由 vidLinkDistill 批量模式生成。*');

  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, 'index.md');
  fs.writeFileSync(p, L.join('\n'), 'utf8');
  return p;
}

function copyNotesTo(notesPath, outDir, ep) {
  const base = `P${pad2(ep.seq || ep.page)}-${slugify(ep.part, 32)}.md`;
  const dest = path.join(outDir, base);
  try { fs.copyFileSync(notesPath, dest); return dest; }
  catch (e) { log('  ! 复制成品失败：' + e.message); return notesPath; }
}

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const series = await resolveSeries(args);

  const picked = parsePageSpec(args.pages, series.episodes.length);
  const eps = picked.map(n => series.episodes[n - 1]).filter(Boolean);
  if (!eps.length) throw new Error('选集范围为空，检查 --pages');
  const totalDur = eps.reduce((a, e) => a + (e.duration || 0), 0);
  const slug = slugify(series.name);
  const outDir = args.out ? path.resolve(args.out) : path.join(ROOT, 'out', slug);

  /* --- 清单模式 --- */
  if (args.action === 'list') {
    const asr = Math.round(totalDur / 18);
    console.log(JSON.stringify({
      ok: true, action: 'list',
      series: series.name, owner: series.owner,
      totalEpisodes: series.episodes.length, picked: eps.length,
      totalDuration: ts(totalDur),
      estimate: {
        note: '下列是「采集素材」的耗时，不含后续逐集提炼成笔记的时间',
        withSubtitle: '命中官方字幕：约 3–10 秒/集',
        byAsr: `命中不到字幕走本地转写：约 18 倍速 ≈ ${ts(asr)}（${(asr / 60).toFixed(1)} 分钟）`,
        ocr: args.ocr === 'off' ? '已关闭画面识别（不加媒体下载，最快）' : '已开启画面识别（需下载低清视频，慢约 30%–80%）'
      },
      outDir,
      episodes: eps.map(e => ({ seq: e.seq, page: e.page, part: e.partLabel, duration: ts(e.duration), url: e.url, state: epState(e).state }))
    }, null, 1));
    return;
  }

  /* --- 采集模式 --- */
  const rows = [];
  if (args.action === 'collect') {
    log('');
    log(`《${series.name}》共 ${series.episodes.length} 集，本次处理 ${eps.length} 集，合计 ${ts(totalDur)}`);
    log(`交付目录：${outDir}`);
    log('');

    let idx = 0;
    for (const ep of eps) {
      idx++;
      const tag = `[${idx}/${eps.length}] P${ep.seq || ep.page} ${ep.part}`;
      const st = epState(ep);

      if (st.state === 'done' && !args.force) {
        log(`${tag} — 已有成品，跳过`);
        rows.push(ep);
        continue;
      }
      if (st.state === 'material' && !args.force) {
        log(`${tag} — 素材已采集，待提炼`);
        rows.push(ep);
        continue;
      }
      if (args.maxMinutes && ep.duration > args.maxMinutes * 60) {
        log(`${tag} — 超过 --max-minutes=${args.maxMinutes}，跳过`);
        rows.push({ ...ep, state: 'failed', error: `超时长上限 ${args.maxMinutes} 分钟` });
        continue;
      }

      log(`${tag} — 采集开始（${ts(ep.duration)}）`);
      const t = Date.now();
      const r = await runKb(ep, args);
      const el = ((Date.now() - t) / 1000).toFixed(0) + 's';

      if (r.code === 0 && r.json && r.json.ok) {
        log(`${tag} — 采集完成 ${el}｜${r.json.audio.source}｜${r.json.sections} 段素材`);
        rows.push(ep);
      } else {
        const err = (r.json && r.json.error) || r.stderr.split('\n').filter(Boolean).pop() || `退出码 ${r.code}`;
        log(`${tag} — 失败 ${el}：${err}`);
        rows.push({ ...ep, state: 'failed', error: String(err).slice(0, 100) });
      }
      await sleep(800);
    }
  } else {
    log('· 索引模式：扫描已有产物');
    for (const ep of eps) rows.push(ep);
  }

  /* --- 汇总索引 --- */
  const detail = rows.map(r => {
    if (r.state === 'failed') {
      return { ...r, themes: [], audio: '', tldr: '', blocks: 0, duration: r.duration || 0 };
    }
    const s = summarize(r);
    return { ...r, ...s, duration: r.duration || 0 };
  });

  // 成品笔记按集复制到交付目录，便于整包发放
  fs.mkdirSync(outDir, { recursive: true });
  for (const d of detail) {
    if (d.state === 'done' && d.notes) d.file = copyNotesTo(d.notes, outDir, d);
  }

  const indexPath = buildIndex(series, detail, args, outDir);
  const doneN = detail.filter(d => d.state === 'done').length;
  const matN = detail.filter(d => d.state === 'material').length;
  const failed = detail.filter(d => d.state === 'failed');

  console.log(JSON.stringify({
    ok: failed.length === 0,
    action: args.action,
    series: series.name,
    total: eps.length,
    done: doneN,
    material: matN,
    failed: failed.map(f => ({ page: f.page, part: f.partLabel, error: f.error })),
    index: indexPath,
    outDir,
    elapsed: ((Date.now() - t0) / 1000 / 60).toFixed(1) + ' 分钟',
    needDistill: detail.filter(d => d.state === 'material').map(d => ({
      page: d.seq || d.page, part: d.partLabel,
      digest: path.join(workDirFor(d), 'digest.json'),
      hint: '读 digest.md 素材 → 写 notes.json → node render.js <notes.json>'
    })),
    episodes: detail.map(d => ({
      seq: d.seq, page: d.page, part: d.partLabel, state: d.state,
      duration: ts(d.duration), audio: d.audio || null,
      themes: d.themes.map(t => t.title).slice(0, 8), file: d.file || null
    }))
  }, null, 1));
}

main().catch(e => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
