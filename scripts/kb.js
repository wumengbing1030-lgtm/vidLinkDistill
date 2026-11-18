#!/usr/bin/env node
'use strict';
/**
 * kb.js —— B站视频 → 知识点笔记 的采集/清洗/分段流水线（本地零依赖）
 *
 * 用法（手机端只需把链接和 SESSDATA 发过来，由 Agent 执行本命令）：
 *   node kb.js "<B站链接或分享文案>" [--sessdata=xxx] [--frames=40] [--budget=15000] [--mode=full|lite]
 *
 * 输出（目录 out/<bvid>_P<n>/）：
 *   meta.json     视频元信息
 *   audio.json    带时间戳的语句（官方字幕优先，失败降级本地转写）
 *   ocr.json      关键帧画面文字块（带起止时间）
 *   digest.md     紧凑素材包（供写作，含时间戳/来源/类型标记，严格控制体积）
 *   digest.json   结构化素材（RAG 元数据用）
 *
 * 设计约束：任何一步失败都只降级并标注，不中断整条流水线；重试最多 2 次。
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OCR_URL = 'http://127.0.0.1:8767';
const DAEMON_URL = 'http://127.0.0.1:8766';
const ROOT = process.env.KB_WORK_DIR || __dirname;   // 素材与缓存目录，可用 KB_WORK_DIR 覆盖
const WARN = [];
const warn = m => { if (!WARN.includes(m)) WARN.push(m); };

/* ---------------------------------------------------------------- 基础工具 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function requestUrl(rawUrl, { headers = {}, method = 'GET', timeout = 20000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method,
      headers: { 'User-Agent': UA, ...headers }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch (e) { return reject(e); }
        return resolve(requestUrl(next, { headers, method, timeout, redirects: redirects - 1 }));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8') });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时(' + timeout + 'ms)')));
    req.on('error', reject);
    req.end();
  });
}

const jsonOf = r => { try { return JSON.parse(r.text); } catch (e) { return null; } };
const stripHtml = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function withRetry(label, times, fn) {
  let last = null;
  for (let i = 0; i <= times; i++) {
    try { return await fn(i); } catch (e) { last = e; if (i < times) await sleep(500 * (i + 1)); }
  }
  throw new Error(label + '失败(已重试' + times + '次): ' + (last && last.message));
}

const pad2 = n => String(n).padStart(2, '0');
function ts(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

function cleanShareText(input) {
  const s = String(input || '').trim();
  const m = s.match(/https?:\/\/[^\s，。、）)】"']+/);
  if (m) return m[0];
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return 'https://www.bilibili.com/video/' + bv[0];
  const av = s.match(/av(\d+)/i);
  if (av) return 'https://www.bilibili.com/video/av' + av[1];
  return s;
}

function extractIds(url) {
  const bv = url.match(/BV[0-9A-Za-z]{10}/);
  const av = url.match(/\/av(\d+)/i) || url.match(/[?&]aid=(\d+)/);
  return { bvid: bv ? bv[0] : null, aid: av ? av[1] : null };
}

async function normalizeShortLink(url) {
  if (!/b23\.tv|bili\.2233\.cn/.test(url)) return url;
  try {
    const r = await requestUrl(url, { method: 'HEAD', timeout: 10000 });
    return r.headers.location || url;
  } catch (e) { return url; }
}

/* ---------------------------------------------------------------- 参数 */
function parseArgs(argv) {
  const out = { input: '', sessdata: '', frames: 40, budget: 15000, mode: 'full', model: 'small', file: '', title: '', sub: '', ocr: 'on', dlparts: 0, remote: 'on' };
  for (const a of argv) {
    if (a.startsWith('--ocr=')) out.ocr = /^(off|no|0|false)$/i.test(a.slice(6)) ? 'off' : 'on';
    else if (a.startsWith('--sessdata=')) out.sessdata = a.slice(11).trim();
    else if (a.startsWith('--frames=')) out.frames = parseInt(a.slice(9), 10) || 40;
    else if (a.startsWith('--budget=')) out.budget = parseInt(a.slice(9), 10) || 15000;
    else if (a.startsWith('--mode=')) out.mode = a.slice(7) === 'lite' ? 'lite' : 'full';
    else if (a.startsWith('--from=')) out.from = parseInt(a.slice(7), 10) || 0;
    else if (a.startsWith('--model=')) out.model = a.slice(8);
    else if (a.startsWith('--url=')) out.input = a.slice(6);
    else if (a.startsWith('--file=')) out.file = a.slice(7).trim().replace(/^["']|["']$/g, '');
    else if (a.startsWith('--title=')) out.title = a.slice(8).trim();
    else if (a.startsWith('--sub=')) out.sub = a.slice(6).trim().replace(/^["']|["']$/g, '');
    else if (a.startsWith('--dlparts=')) out.dlparts = parseInt(a.slice(10), 10) || 0;
    else if (a.startsWith('--remote=')) out.remote = /^(off|no|0|false)$/i.test(a.slice(9)) ? 'off' : 'on';
    else if (!a.startsWith('--')) out.input = out.input || a;
  }
  return out;
}

/* ---------------------------------------------------------------- ① 元信息 + 字幕列表 */
async function fetchMeta(input, sessdata) {
  const cleaned = cleanShareText(input);
  const url = await normalizeShortLink(cleaned);
  const { bvid, aid } = extractIds(url);
  if (!bvid && !aid) throw new Error('未识别到 BV/av 号，请直接粘贴视频链接');

  const cookie = sessdata ? `SESSDATA=${sessdata}` : '';
  const H = () => (cookie ? { Referer: 'https://www.bilibili.com/', Cookie: cookie } : { Referer: 'https://www.bilibili.com/' });
  const key = bvid ? `bvid=${bvid}` : `aid=${aid}`;

  let pages = [];
  try {
    const d = jsonOf(await requestUrl(`https://api.bilibili.com/x/player/pagelist?${key}`, { headers: H() }));
    if (d && d.code === 0) pages = d.data || [];
  } catch (e) { warn('分P列表获取失败，按单P处理'); }

  const pMatch = String(input).match(/[?&]p=(\d+)/) || url.match(/[?&]p=(\d+)/);
  const reqP = pMatch ? parseInt(pMatch[1], 10) : 1;
  const pageNo = pages.length ? Math.min(Math.max(1, reqP), pages.length) : 1;
  const sel = pages[pageNo - 1] || {};
  const cid = sel.cid || (pages[0] || {}).cid || null;

  let title = (sel.part || bvid || ('av' + aid)).trim();
  let owner = '', duration = sel.duration || 0, desc = '';
  try {
    const d = jsonOf(await requestUrl(`https://api.bilibili.com/x/web-interface/view?${key}`, { headers: H() }));
    if (d && d.code === 0 && d.data) {
      desc = d.data.desc || '';
      owner = (d.data.owner && d.data.owner.name) || '';
      title = pages.length > 1
        ? `${d.data.title} · P${pageNo}${sel.part ? ' ' + sel.part : ''}`
        : (d.data.title || title);
      if (!duration) duration = pages.length > 1 ? (sel.duration || 0) : (d.data.duration || 0);
    }
  } catch (e) { warn('视频信息接口失败，标题可能不完整'); }

  // 字幕列表：code -101 = 未登录（SESSDATA 缺失/失效）
  let subtitles = [];
  let expired = false;
  if (cid) {
    try {
      const d = jsonOf(await requestUrl(`https://api.bilibili.com/x/player/v2?${key}&cid=${cid}`, { headers: H() }));
      if (d) {
        if (d.code === -101) expired = !!sessdata;
        if (d.code === 0) {
          if (d.data && d.data.login_mid === 0 && sessdata) expired = true;
          subtitles = (d.data && d.data.subtitle && d.data.subtitle.subtitles) || [];
        }
      }
    } catch (e) { warn('字幕列表接口失败，将走语音转写'); }
  }

  // DASH 直链（音频/视频各取最低码率）
  let audioUrls = [], videoUrls = [];
  if (cid) {
    try {
      const d = jsonOf(await requestUrl(`https://api.bilibili.com/x/player/playurl?${key}&cid=${cid}&qn=16&fnval=16&fourk=0`, { headers: H() }));
      if (d && d.code === 0 && d.data && d.data.dash) {
        const pick = list => {
          const arr = (list || []).slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
          const out = [];
          for (const it of arr) {
            if (it.baseUrl && !out.includes(it.baseUrl)) out.push(it.baseUrl);
            for (const b of (it.backupUrl || [])) if (b && !out.includes(b)) out.push(b);
          }
          return out;
        };
        audioUrls = pick(d.data.dash.audio);
        videoUrls = pick(d.data.dash.video);
      }
    } catch (e) { warn('播放地址接口失败，可能无法转写/识别画面'); }
  }

  return {
    url, bvid, aid, cid, pageNo, pageCount: pages.length, title, owner, duration, desc, expired,
    hasSessdata: !!sessdata,
    subtitles: subtitles.map(s => ({
      lan: s.lan, lanDoc: s.lan_doc,
      url: s.subtitle_url ? (s.subtitle_url.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url) : null
    })),
    audioUrls, videoUrls
  };
}

/* ---------------------------------------------------------------- ② 采集：字幕 / 转写 / OCR */
function pickSubtitle(subs) {
  if (!subs || !subs.length) return null;
  const score = s => {
    const lan = (s.lan || '').toLowerCase();
    if (/zh-cn|zh-hans|zh_cn/.test(lan)) return 100;
    if (/^ai-zh/.test(lan)) return 90;
    if (/zh-hant|zh-tw/.test(lan)) return 70;
    if (/^zh/.test(lan)) return 60;
    if (/^ai-en/.test(lan)) return 20;
    return 10;
  };
  return subs.slice().sort((a, b) => score(b) - score(a))[0];
}

async function fetchSubtitleCues(sub, sessdata) {
  if (!sub || !sub.url) return [];
  const H = { Referer: 'https://www.bilibili.com/' };
  if (sessdata) H.Cookie = `SESSDATA=${sessdata}`;
  const r = await withRetry('字幕下载', 2, () => requestUrl(sub.url, { headers: H, timeout: 20000 }));
  const txt = r.text.replace(/^\uFEFF/, '').trim();
  let cues = [];
  if (txt.startsWith('{')) {
    const d = JSON.parse(txt);
    cues = (d.body || []).map(it => ({ t: Number(it.from) || 0, e: Number(it.to) || 0, text: stripHtml(it.content) }));
  } else {
    // srt
    const blocks = txt.split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const m = b.match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
      if (!m) continue;
      const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
      const e = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
      const text = stripHtml(b.split(/\r?\n/).slice(2).join(' '));
      if (text) cues.push({ t, e, text });
    }
  }
  // 去掉空行与连续重复行
  const out = [];
  for (const c of cues) {
    if (!c.text) continue;
    if (out.length && out[out.length - 1].text === c.text) continue;
    out.push(c);
  }
  return out;
}

function verifyMediaFile(dest) {
  const size = fs.statSync(dest).size;
  if (size < 1024) throw new Error('下载文件过小(' + size + 'B)');
  const fd = fs.openSync(dest, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  const s4 = head.slice(0, 4).toString('latin1').toLowerCase();
  const isHtml = s4.startsWith('<htm') || head.slice(0, 5).toString('latin1').toLowerCase().includes('<!doc');
  const isMedia = head.slice(4, 8).toString('latin1') === 'ftyp' || s4 === 'riff' ||
    head.slice(0, 3).toString('latin1') === 'ID3' || (head[0] === 0x1a && head[1] === 0x45);
  if (isHtml || !isMedia) throw new Error('CDN 返回非媒体内容');
  return size;
}

function downloadMedia(url, dest, sessdata) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-L', '--retry', '2', '--retry-delay', '1', '-m', '900',
      '-H', 'Referer: https://www.bilibili.com/', '-H', 'User-Agent: ' + UA];
    if (sessdata) args.push('-H', 'Cookie: SESSDATA=' + sessdata);
    args.push(url, '-o', dest);
    const p = spawn('curl', args, { env: { ...process.env } });
    let err = '';
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => {
      if (code !== 0) return reject(new Error('下载失败: ' + err.slice(-160)));
      try {
        const size = verifyMediaFile(dest);
        resolve({ path: dest, size });
      } catch (e) { reject(e); }
    });
    p.on('error', reject);
  });
}

/* --- 探测文件总长（Range 探测，服务器不支持则返回 0） --- */
function probeTotal(url, sessdata) {
  return new Promise(resolve => {
    const args = ['-sS', '-L', '--max-time', '25', '-r', '0-0', '-D', '-', '-o', 'NUL',
      '-H', 'Referer: https://www.bilibili.com/', '-H', 'User-Agent: ' + UA];
    if (sessdata) args.push('-H', 'Cookie: SESSDATA=' + sessdata);
    args.push(url);
    const p = spawn('curl', args);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', () => {
      const m = out.match(/content-range:\s*bytes\s+0-0\/(\d+)/i);
      resolve(m ? { total: parseInt(m[1], 10), partial: true } : { total: 0, partial: false });
    });
    p.on('error', () => resolve({ total: 0, partial: false }));
  });
}

/* --- 下载一个字节区间 --- */
function curlRange(url, dest, sessdata, start, end) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-L', '--retry', '2', '--retry-delay', '1', '-m', '900',
      '-r', start + '-' + end,
      '-H', 'Referer: https://www.bilibili.com/', '-H', 'User-Agent: ' + UA];
    if (sessdata) args.push('-H', 'Cookie: SESSDATA=' + sessdata);
    args.push(url, '-o', dest);
    const p = spawn('curl', args);
    let err = '';
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => {
      if (code !== 0) return reject(new Error('分片下载失败: ' + err.slice(-120)));
      try {
        const size = fs.statSync(dest).size;
        const want = end - start + 1;
        if (size !== want) return reject(new Error('分片长度不符 ' + size + '/' + want));
        resolve({ path: dest, size });
      } catch (e) { reject(e); }
    });
    p.on('error', reject);
  });
}

function concatParts(dest, files) {
  const fd = fs.openSync(dest, 'w');
  const buf = Buffer.alloc(1 << 20);
  try {
    for (const f of files) {
      const rf = fs.openSync(f, 'r');
      try {
        let n;
        while ((n = fs.readSync(rf, buf, 0, buf.length, null)) > 0) fs.writeSync(fd, buf, 0, n);
      } finally { fs.closeSync(rf); }
    }
  } finally { fs.closeSync(fd); }
}

/* --- 并发分段下载：CDN 单连接约 200KB/s，多连接可线性提速 --- */
async function downloadParallel(url, dest, sessdata, parts) {
  const MIN = 8 * 1024 * 1024;          // 小文件不值得并发
  if (parts && parts <= 1) return null;  // 显式要求单连接（用于对照/排障）
  const probe = await probeTotal(url, sessdata);
  if (!probe.partial || !probe.total || probe.total < MIN) return null;
  const n = Math.max(2, Math.min(parts || 4, 8, Math.ceil(probe.total / MIN)));
  const chunk = Math.ceil(probe.total / n);
  const segs = [];
  for (let i = 0; i < n; i++) {
    const start = i * chunk;
    const end = Math.min(probe.total - 1, start + chunk - 1);
    if (start <= end) segs.push({ i, start, end, file: dest + '.part' + i });
  }
  const t0 = Date.now();
  console.log(JSON.stringify({
    progress: 'download', mode: 'parallel', parts: segs.length,
    sizeMB: +(probe.total / 1048576).toFixed(1)
  }));
  try {
    await Promise.all(segs.map(s => withRetry('分片' + (s.i + 1), 3, () => curlRange(url, s.file, sessdata, s.start, s.end))));
    concatParts(dest, segs.map(s => s.file));
    const size = fs.statSync(dest).size;
    if (size !== probe.total) throw new Error('合并后大小不符 ' + size + '/' + probe.total);
    verifyMediaFile(dest);
    return { path: dest, size, parallel: segs.length, sec: Math.round((Date.now() - t0) / 1000) };
  } finally {
    for (const s of segs) { try { fs.unlinkSync(s.file); } catch (e) {} }
  }
}

async function downloadFirst(urls, dest, sessdata, label, parts) {
  let lastErr = null;
  for (const u of urls.slice(0, 3)) {
    // ① 优先并发分段（CDN 单连接限速时提速最明显）
    try {
      const r = await downloadParallel(u, dest, sessdata, parts);
      if (r) return r;
    } catch (e) { lastErr = e; }
    // ② 回退单连接，保证一定能下下来
    try {
      return await withRetry(label + '下载', 2, () => downloadMedia(u, dest, sessdata));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(label + '无可下载地址');
}

function postJSON(base, p, body, timeout) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(base + p, {
      method: 'POST', timeout,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let out = '';
      res.on('data', d => out += d.toString('utf8'));
      res.on('end', () => {
        try {
          const d = JSON.parse(out);
          if (!d.ok) return reject(new Error(d.error || '服务返回失败'));
          resolve(d);
        } catch (e) { reject(new Error('响应解析失败: ' + out.slice(0, 160))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('本地服务超时')));
    req.end(payload);
  });
}

/* --- 长音频分片转写：5 分钟一片，逐片缓存，可断点续跑 --- */
const PY = process.env.PYTHON_EXE || 'C:/Users/wumengbing/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
let LAST_LANG = '';

function runPy(script, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [path.join(__dirname, script), ...argv], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(script + ' 失败: ' + (err || out).slice(-200)))));
    p.on('error', reject);
  });
}

async function transcribeAudio(audioPath, workDir, opts) {
  const model = opts.model || 'small';
  const chunkDir = path.join(workDir, 'chunks');
  const metaPath = path.join(chunkDir, 'chunks.json');
  if (!fs.existsSync(metaPath)) {
    console.log(JSON.stringify({ progress: 'split', note: '音频按 5 分钟切片（长视频可断点续跑）' }));
    await runPy('split_audio.py', [audioPath, chunkDir, '300']);
  }
  const cm = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const N = cm.chunks.length;
  const parts = new Array(N).fill(null);

  // ① 先吃缓存（断点续跑：上次跑过的片段零成本复用）
  const todo = [];
  for (let i = 0; i < N; i++) {
    const cache = cm.chunks[i].file + '.' + model + '.json';
    if (fs.existsSync(cache)) {
      try {
        const q = JSON.parse(fs.readFileSync(cache, 'utf8'));
        if (q && q.ok) { parts[i] = q; continue; }
      } catch (e) { /* 缓存损坏则重跑 */ }
    }
    todo.push(i);
  }

  // ② 未命中缓存的一次性批量提交，由转写服务按 CPU 核数并行跑（这是主要提速点）
  if (todo.length) {
    const knownLang = (parts.find(q => q && q.language) || {}).language || null;
    console.log(JSON.stringify({ progress: 'transcribe_start', pending: todo.length, cached: N - todo.length, total: N, model }));
    const t0 = Date.now();
    const payload = { files: todo.map(i => cm.chunks[i].file), model };
    if (knownLang) payload.language = knownLang;
    let results = null;
    try {
      const r = await postJSON(DAEMON_URL, '/transcribe_batch', payload, 2400000);
      results = Array.isArray(r.results) ? r.results : null;
    } catch (e) {
      // 批量接口不可用（旧版服务/进程池崩溃）→ 退回逐片单文件，保证一定出结果
      console.log(JSON.stringify({ warn: '并行转写不可用，降级为逐段转写：' + e.message }));
      results = [];
      for (const i of todo) {
        try { results.push(await postJSON(DAEMON_URL, '/transcribe', { path: cm.chunks[i].file, model }, 2400000)); }
        catch (e2) { results.push({ ok: false, error: e2.message }); }
      }
    }

    const failed = [];
    for (let k = 0; k < todo.length; k++) {
      const i = todo[k];
      const r = results[k];
      if (r && r.ok && (r.segs || r.lines)) {
        parts[i] = r;
        try { fs.writeFileSync(cm.chunks[i].file + '.' + model + '.json', JSON.stringify(r), 'utf8'); } catch (e) {}
      } else {
        failed.push(i);
      }
    }
    // ③ 失败片段单独重试（最多 2 次），仍失败就跳过——能出多少出多少，绝不卡死
    for (const i of failed) {
      try {
        const r = await withRetry('转写第' + (i + 1) + '段', 2, () => postJSON(DAEMON_URL, '/transcribe', { path: cm.chunks[i].file, model }, 2400000));
        if (r && r.ok) {
          parts[i] = r;
          try { fs.writeFileSync(cm.chunks[i].file + '.' + model + '.json', JSON.stringify(r), 'utf8'); } catch (e) {}
        }
      } catch (e) {
        console.log(JSON.stringify({ warn: '第' + (i + 1) + '段转写失败，已跳过：' + e.message }));
      }
    }
    console.log(JSON.stringify({ progress: 'transcribe', done: N - parts.filter(q => !q).length, total: N, sec: Math.round((Date.now() - t0) / 1000) }));
  } else {
    console.log(JSON.stringify({ progress: 'transcribe', note: '全部命中缓存，跳过转写', total: N }));
  }

  // ④ 按片序拼回带全局时间戳的片段
  const out = [];
  for (let i = 0; i < N; i++) {
    const part = parts[i];
    if (!part) continue;
    LAST_LANG = part.language || LAST_LANG;
    for (const x of part.segs || []) {
      out.push({ t: +(x.t + cm.chunks[i].start).toFixed(1), e: +(x.e + cm.chunks[i].start).toFixed(1), text: x.text });
    }
  }
  const lost = parts.filter(q => !q).length;
  if (lost) console.log(JSON.stringify({ warn: lost + ' 段音频转写失败，对应时段内容缺失' }));
  if (!out.length) throw new Error('转写结果为空');
  fs.writeFileSync(path.join(workDir, 'transcript.json'), JSON.stringify({ segs: out, language: LAST_LANG }), 'utf8');
  return out;
}

/* 繁→简：whisper 中文有时整段输出繁体，用高频字表纠正（零依赖，532 字） */
const T2S_A = '這們機學發對樣個話範疇終會點說裡裏來時間問題開關實現麼認識覺國語應該為與於過還進邊東電腦網絡數據體統製產業務資訊價場營銷費額團隊員門長週讓給從無萬億種類別帶線圖書見觀聽讀寫講練習較難簡單複雜確愛樂興華醫藥療軍戰爭勝處幹變動態標準錯誤負責總結論條階兒記憶權區環節適當構驗證舉補刪擴圍績獎勵贊購賣貨幣銀帳戶轉匯軟項頁鏈載傳輸儲檔視頻聲畫質運濟稅債貸險賠損亞歐陸島灣縣鄉鎮鐵車飛糧農漁礦鋼織慶藝歲歷麗擁擔擇擾攝擬擊擺攜敵斷舊雖雙離靈靜響顯風飯養驚髮鬥魚鳥鹽黃齊齒龍龜幫張強彌彎徹惱慣慮憂憐擠敗晉暈暢曆極橋檢歸殘殺殼毀氣決沒況淚淨減測湧湯溝滅滾漲澀濕瀉灑灘煙煩熱燈燒燦爺牆獨獲畢異盡監盤眾睜矯碼礙礎禍穩窮竄筆築籃籠糾紀約紅純紙級緊組細紹絕絲經綠維綱緒編緩繞繪繼續罰罷義聯職肅脅腎臉臨艙蘇號蟲術衛衝裝襯規親計訂訓訪設許訴診註詞試詳誌誠誰課調談請諸諾謀謂謝譜議護讚貝財貢販貪貴買貼賈賓賜賞賢賤賦賬賭賽贈趕趨跡踐蹤軌軒輔輕輛輝輩輪輯轄辭迴連遊達違遙遠遜選遷遺遼邁邏郵鄒釋針釘釣鈴銅鋒鋪錄錘錢錦錫錶鍵鐘鑄鑑閉閑閱闆闡陝陣陰陳陽隨隱雞雲霧韻頂順須預頑頓頗領頭顆顏願飲飼館馬駕駛駐騎騙鮮鳴鴨鴻鵝鷹麥膚膽腸腫臟膠膩紮綁綿綜緯緻縫繩纏纖翹聳聰腳脫艱莊萊葉著蘿虛蝦蟻蠟蠻褲襪覓覽觸託評誇諒譯';
const T2S_B = '这们机学发对样个话范畴终会点说里里来时间问题开关实现么认识觉国语应该为与于过还进边东电脑网络数据体统制产业务资讯价场营销费额团队员门长周让给从无万亿种类别带线图书见观听读写讲练习较难简单复杂确爱乐兴华医药疗军战争胜处干变动态标准错误负责总结论条阶儿记忆权区环节适当构验证举补删扩围绩奖励赞购卖货币银账户转汇软项页链载传输储档视频声画质运济税债贷险赔损亚欧陆岛湾县乡镇铁车飞粮农渔矿钢织庆艺岁历丽拥担择扰摄拟击摆携敌断旧虽双离灵静响显风饭养惊发斗鱼鸟盐黄齐齿龙龟帮张强弥弯彻恼惯虑忧怜挤败晋晕畅历极桥检归残杀壳毁气决没况泪净减测涌汤沟灭滚涨涩湿泻洒滩烟烦热灯烧灿爷墙独获毕异尽监盘众睁矫码碍础祸稳穷窜笔筑篮笼纠纪约红纯纸级紧组细绍绝丝经绿维纲绪编缓绕绘继续罚罢义联职肃胁肾脸临舱苏号虫术卫冲装衬规亲计订训访设许诉诊注词试详志诚谁课调谈请诸诺谋谓谢谱议护赞贝财贡贩贪贵买贴贾宾赐赏贤贱赋账赌赛赠赶趋迹践踪轨轩辅轻辆辉辈轮辑辖辞回连游达违遥远逊选迁遗辽迈逻邮邹释针钉钓铃铜锋铺录锤钱锦锡表键钟铸鉴闭闲阅板阐陕阵阴陈阳随隐鸡云雾韵顶顺须预顽顿颇领头颗颜愿饮饲馆马驾驶驻骑骗鲜鸣鸭鸿鹅鹰麦肤胆肠肿脏胶腻扎绑绵综纬致缝绳缠纤翘耸聪脚脱艰庄莱叶着萝虚虾蚁蜡蛮裤袜觅览触托评夸谅译';
const T2S_MAP = (() => {
  const m = new Map();
  for (let i = 0; i < T2S_A.length; i++) m.set(T2S_A[i], T2S_B[i]);
  return m;
})();
function toSimplified(t) {
  const str = String(t || '');
  let hit = false;
  const out = str.replace(/[\u4e00-\u9fa5]/g, ch => {
    const v = T2S_MAP.get(ch);
    if (v) { hit = true; return v; }
    return ch;
  });
  return hit ? out : str;
}

/* --- 语句归并：把碎片字幕合成通顺句子，保留起始时间戳 --- */
const END_PUNCT = /[。！？!?；;…]$/;
const END_PUNCT_LATIN = /[.!?]$/;
function cuesToSentences(cues) {
  const out = [];
  let buf = '', start = null, end = 0, prevEnd = -1;
  const flush = () => {
    const isLatin = /[A-Za-z]/.test(buf) && !/[\u4e00-\u9fa5]/.test(buf);
    const text = buf.replace(/\s{2,}/g, isLatin ? ' ' : '').trim();
    if (text) out.push({ t: Math.round(start || 0), e: Math.round(end), text });
    buf = ''; start = null;
  };
  for (const c of cues) {
    if (start === null) start = c.t;
    const piece = String(c.text || '').replace(/\s+/g, ' ').trim();
    if (!piece) continue;
    // 英文单词之间要留空格，中文直接拼接
    if (buf && /[A-Za-z0-9,]$/.test(buf) && /^[A-Za-z0-9]/.test(piece)) buf += ' ';
    buf += piece;
    end = c.e || c.t;
    const gap = prevEnd >= 0 ? c.t - prevEnd : 0;
    const isLatin = /[A-Za-z]/.test(buf) && !/[\u4e00-\u9fa5]/.test(buf);
    const cond = isLatin
      ? ((END_PUNCT_LATIN.test(buf) && buf.length >= 80) || buf.length >= 180 || (gap > 2 && buf.length >= 60))
      : (buf.length >= 26 || (END_PUNCT.test(buf) && buf.length >= 8) || (gap > 1.5 && buf.length >= 10) || buf.length >= 60);
    prevEnd = end;
    if (cond) flush();
  }
  flush();
  // 句内去重（同句重复出现，常见于 AI 字幕）
  const seen = new Set();
  return out.filter(s => {
    const k = s.text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    if (k.length < 4 || seen.has(k)) return false;
    seen.add(k); return true;
  });
}

/* ---------------------------------------------------------------- ③ 清洗：口水词 / 广告 / 去重 */
const FILLER_HEAD = /^(那么|然后呢|然后|接下来|这个|那个|就是说|也就是说|其实|呃|嗯|啊|哦|好吧|好的|好|OK|ok|我们来看|我们来看一下|大家看|大家可以看到|注意一下|这里|所以说)[，,、\s]*/;
const AD_WORDS = ['关注', '点赞', '投币', '收藏', '转发', '三连', '公众号', '微信', '加我', '私信', '课程', '训练营',
  '优惠', '报名', '扫码', '二维码', '小黄车', '橱窗', '下单', '购买', '链接在', '评论区', '粉丝群', '直播间',
  '广告合作', '商务合作', '置顶', '会员', '付费', '领取', '福利', '抽奖', '拼团', '限时',
  'subscribe', 'like and subscribe', 'link in the description', 'patreon', 'sponsor'];

function adScore(text) {
  let s = 0;
  for (const w of AD_WORDS) if (text.includes(w)) s++;
  if (/三连|一键三连|关注我|点赞投币|公众号|扫码|小黄车|加微信/.test(text)) s += 2;
  return s;
}

function cleanSentences(sentences) {
  const kept = [];
  const adBlocks = [];
  let adRun = null;

  for (const s of sentences) {
    // 口水词只削句首（可连续多层），不动句中出现的内容
    let text = toSimplified(s.text);
    if (isLatinText(text)) { if (text.length < 20) continue; }
    for (let i = 0; i < 4 && !isLatinText(text); i++) {
      const next = text.replace(FILLER_HEAD, '');
      if (next === text) break;
      text = next;
    }
    if (text.length < 6) continue;
    const a = adScore(text);
    if (a >= 2) {
      if (adRun && s.t - adRun.t1 <= 20) { adRun.t1 = s.e; adRun.n++; adRun.score = Math.max(adRun.score, a); }
      else { if (adRun) adBlocks.push(adRun); adRun = { t0: s.t, t1: s.e, n: 1, score: a }; }
      continue;
    }
    if (adRun) { adBlocks.push(adRun); adRun = null; }
    kept.push({ t: s.t, e: s.e, text, ad: a === 1 });
  }
  if (adRun) adBlocks.push(adRun);

  // 广告块：合并后的连续广告句即广告时段（关键词命中 >=2 才算，误杀低）
  const adSegments = adBlocks.map(b => ({ t0: b.t0, t1: b.t1, n: b.n }));

  // 近似去重：归一化后互为包含 / 完全相同
  const norm = t => t.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const out = [];
  for (const s of kept) {
    const k = norm(s.text);
    const dup = out.some(o => {
      const ok = norm(o.text);
      if (ok === k) return true;
      if (k.length >= 12 && ok.length >= 12 && (ok.includes(k) || k.includes(ok))) {
        return Math.min(k.length, ok.length) / Math.max(k.length, ok.length) > 0.72;
      }
      return false;
    });
    if (!dup) out.push(s);
  }
  return { sentences: out, adSegments };
}

/* ---------------------------------------------------------------- ④ 分段 + 知识点候选 */
const CUE_EN = {
  定义: /\b(is|are|means|refers to|defined as|called|known as|essentially|what it is)\b/i,
  原理: /\b(because|since|due to|reason|mechanism|leads to|causes|as a result|so that)\b/i,
  结论: /\b(so|therefore|thus|conclusion|in short|the key is|means that|that's why)\b/i,
  对比: /\b(vs|versus|compared|difference|unlike|whereas|instead|rather than|better than)\b/i,
  实操: /\b(first|second|third|then|next|step|how to|setup|set up|configure|run|use this|tool)\b/i,
  限制: /\b(but|however|unless|only|cannot|can't|must|avoid|risk|caveat|downside|limit|depends|tricky)\b/i
};
const CUE = {
  定义: /(是指|指的是|叫做|称为|定义|所谓|意思是|本质上就是|通俗来说|专业术语|概念)/,
  原理: /(因为|由于|原理|机制|导致|造成|本质上|规律|原因在于|之所以)/,
  结论: /(结论|所以|因此|说明|可见|总结一下|归根结底|关键是|最终|结果就是|证明了)/,
  对比: /(相比|对比|区别|差异|不同点|优势|劣势|反而|而另一|前者|后者|vs)/i,
  实操: /(第一步|第二步|首先|其次|然后|接着|操作|点击|设置|输入|打开|流程|步骤|做法|方法是)/,
  限制: /(注意|限制|风险|边界|除非|只有|必须|不能|避免|前提|适用|切忌|千万|否则|局限)/
};

function isLatinText(t) {
  return /[A-Za-z]/.test(t) && !/[\u4e00-\u9fa5]/.test(t);
}
function classify(text) {
  const latin = isLatinText(text);
  const hits = [];
  const dict = latin ? CUE_EN : CUE;
  for (const [k, re] of Object.entries(dict)) if (re.test(text)) hits.push(k);
  const len = text.length;
  let bonus = 0;
  if (/\d/.test(text)) bonus += 2;
  if (latin) {
    if (len >= 60 && len <= 300) bonus += 2;
    if (len < 50) bonus -= 3;          // "You know what I mean?" 这类寒暄
    if (len > 420) bonus -= 2;
  } else {
    if (len >= 14 && len <= 60) bonus += 2;
    if (len > 90) bonus -= 2;
  }
  return { types: hits, score: hits.length * 3 + bonus };
}

const SEC_GAP = 75;      // 语句间隔超过 75s 视为换话题
const SEC_MAX = 300;     // 单段最长 5 分钟（长视频分块，防上下文暴涨）

function buildSections(sentences, ocrBlocks) {
  const secs = [];
  let cur = null;
  for (const s of sentences) {
    const startNew = !cur || (s.t - cur.t1 > SEC_GAP) || (s.t - cur.t0 > SEC_MAX);
    if (startNew) {
      cur = { idx: secs.length + 1, t0: s.t, t1: s.e, items: [], ocr: [] };
      secs.push(cur);
    }
    const c = classify(s.text);
    cur.items.push({ t: s.t, e: s.e, text: s.text, types: c.types, score: c.score });
    cur.t1 = Math.max(cur.t1, s.e);
  }
  // OCR 块归入对应段落（无音频时也能成立：按时间就近）
  for (const b of ocrBlocks) {
    let host = secs.find(x => b.t0 >= x.t0 - 5 && b.t0 <= x.t1 + 5);
    if (!host && secs.length) {
      // 落在空档：找时间上最近的段
      host = secs.reduce((a, c) => (Math.abs((c.t0 + c.t1) / 2 - b.t0) < Math.abs((a.t0 + a.t1) / 2 - b.t0) ? c : a), secs[0]);
    }
    if (host) host.ocr.push(b);
  }
  if (!secs.length && ocrBlocks.length) {
    secs.push({ idx: 1, t0: ocrBlocks[0].t0, t1: ocrBlocks[ocrBlocks.length - 1].t1, items: [], ocr: ocrBlocks.slice() });
  }
  return secs;
}

/* --- 融合：画面烧录字幕 校 音频同音字；纯字幕行不重复输出 --- */
function bigramSet(s) {
  const t = String(s).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}
// a 的字符二元组有多少比例出现在 b 中（短串对长串的包含率）
function containRatio(a, b) {
  const A = bigramSet(a), B = bigramSet(b);
  if (!A.size || !B.size) return 0;
  let c = 0;
  for (const x of A) if (B.has(x)) c++;
  return c / A.size;
}

const STOP_PHRASE = /^(的|了|是|在|我|你|他|她|它|这|那|就|也|都|还|又|和|与|有|没|不|一个|我们|你们|他们|什么|怎么|因为|所以|但是|然后|其实|可以|这个|那个|就是|如果|虽然|或者|而且|已经|不是|没有|这样|那样)$/;

// 画面噪声清洗：水印 / UP名 / 站名 / 纯数字时间码
function sanitizeOcr(blocks, meta) {
  const upKey = String(meta.owner || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const cleaned = [];
  for (const b of blocks) {
    const lines = [];
    for (const raw of b.lines) {
      const t = toSimplified(String(raw).trim());
      if (t.length < 2) continue;
      if (/^(bilibili|哔哩哔哩|B站)$/i.test(t)) continue;
      if (/b[i1l]+[b8][i1l]?/i.test(t)) continue;                   // 站名水印（含 OCR 变体 bilbili/libili）
      const cjkOnly = t.replace(/[^\u4e00-\u9fa5]/g, '');
      const latOnly = (t.match(/[A-Za-z]+/g) || []).join('');
      if (latOnly.length >= 3 && cjkOnly.length >= 1 && cjkOnly.length <= 8) continue; // 中英混排小字=水印
      if (upKey && cjkOnly === upKey) continue;
      if (/^\d{1,2}[:：]\d{2}([:：]\d{2})?$/.test(t)) continue;   // 时间码
      if (/^[\d.,%+\-\s]+$/.test(t)) continue;                    // 纯数字
      if (/^[A-Za-z]{1,3}$/.test(t)) continue;                     // 单字母
      lines.push(t);
    }
    if (lines.length) cleaned.push({ ...b, lines });
  }
  // 固定水印/角标：短行 + 重复出现 + 时间跨度覆盖大半片子（内容行只在局部出现）
  const total = Number(meta && meta.duration) || 0;
  const stat = new Map();
  for (const b of cleaned) {
    for (const l of b.lines) {
      const v = stat.get(l) || { n: 0, t0: b.t0, t1: b.t1 };
      v.n++; v.t0 = Math.min(v.t0, b.t0); v.t1 = Math.max(v.t1, b.t1);
      stat.set(l, v);
    }
  }
  const watermark = new Set();
  for (const [l, v] of stat) {
    if (v.n < 3 || l.length > 10) continue;
    if (/[，。！？、,.!?；;]/.test(l)) continue;
    const cover = total > 0 ? (v.t1 - v.t0) / total : v.n / Math.max(1, cleaned.length);
    if (cover >= 0.6) watermark.add(l);
  }
  if (watermark.size) {
    for (const b of cleaned) b.lines = b.lines.filter(l => !watermark.has(l));
  }
  return cleaned.filter(b => b.lines.length);
}

function fuse(ocrBlocks, sentences) {
  let fixed = 0, droppedBlocks = 0, subLines = 0;
  const blocks = [];
  for (const b of ocrBlocks) {
    const near = sentences.filter(s => s.e >= b.t0 - 3 && s.t <= b.t1 + 3);
    const aText = near.map(s => s.text).join('');
    const keep = [], burn = [];
    for (const line of b.lines) {
      const r = aText ? containRatio(line, aText) : 0;
      if (r >= 0.5 && line.length >= 4) burn.push(line);
      else keep.push(line);
    }
    subLines += burn.length;
    if (burn.length) {
      // 画面字幕通常比 whisper 转写准确 → 用它校正同音字（每块只改最匹配的一句，避免重复）
      const subText = burn.join('').replace(/\s+/g, '');
      let best = null, bestScore = 0;
      for (const s of near) {
        const r = containRatio(s.text, subText);
        const fit = subText.length / Math.max(6, s.text.length);
        const score = r * (fit >= 0.7 && fit <= 1.6 ? 1 : 0.6);
        if (score > bestScore) { bestScore = score; best = s; }
      }
      if (best && bestScore >= 0.45 && !best.fixed) {
        best.text = subText; best.fixed = true; fixed++;
      }
    }
    if (keep.length) {
      // 一块里大半是口播字幕 → 整块视为字幕区，剩余行也一并丢弃（避免与音频重复）
      const burnRatio = burn.length / b.lines.length;
      if (!(burn.length && burnRatio >= 0.6)) {
        blocks.push({ ...b, lines: keep });
      } else droppedBlocks++;
    } else droppedBlocks++;
  }
  return { blocks, fixed, droppedBlocks, subLines };
}

function dedupeSentences(list) {
  const norm = t => t.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const out = [];
  for (const s of list) {
    const k = norm(s.text);
    if (k.length < 4) continue;
    const dup = out.some(o => {
      const ok = norm(o.text);
      if (ok === k) return true;
      if (k.length >= 12 && ok.length >= 12 && (ok.includes(k) || k.includes(ok))) {
        return Math.min(k.length, ok.length) / Math.max(k.length, ok.length) > 0.72;
      }
      return false;
    });
    if (!dup) out.push(s);
  }
  return out;
}

/* --- 交叉印证：画面与音频出现同一完整短语（不用滑窗，避免出碎片） --- */
function crossCheck(sec) {
  const audioRaw = sec.items.map(i => i.text).join('|');
  const out = [];
  for (const b of sec.ocr) {
    for (const line of b.lines) {
      const phrases = line.split(/[，,。、；;：:！!？?\s/|【】\[\]（）()《》""''\-—~～]+/);
      for (const p of phrases) {
        const key = p.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
        if (key.length < 3 || key.length > 14) continue;
        if (STOP_PHRASE.test(key)) continue;
        if (audioRaw.includes(key) && !out.includes(key)) out.push(key);
      }
    }
  }
  return out.slice(0, 6);
}

/* ---------------------------------------------------------------- ⑤ 生成紧凑素材包 */
function buildDigest(meta, audioInfo, ocrInfo, sections, opts) {
  const budget = opts.budget || 15000;
  const lines = [];
  const head = [
    `# ${meta.title}`,
    `- 来源：${meta.siteLabel || ('B站 ' + (meta.bvid || 'av' + meta.aid) + (meta.pageCount > 1 ? ' P' + meta.pageNo : ''))} ｜ 时长 ${ts(meta.duration)} ｜ 作者 ${meta.owner || '未知'}`,
    `- 字幕：${audioInfo.source}（${audioInfo.count} 句，${audioInfo.hasTs ? '带时间戳' : '无时间戳'}）｜ 画面文字：${ocrInfo.blocks.length} 块 / ${ocrInfo.frames} 帧`
  ];
  if (!audioInfo.count) head.push('- ⚠️ 音频轨缺失：本次仅用画面文字');
  if (!ocrInfo.blocks.length) head.push('- ⚠️ 画面文字缺失：本次仅用音频');
  if (ocrInfo.blocked) head.push('- ⚠️ ' + ocrInfo.blocked);
  lines.push(...head);

  if (audioInfo.adSegments && audioInfo.adSegments.length) {
    lines.push('', '## 广告时段（已剔除）');
    for (const a of audioInfo.adSegments.slice(0, 6)) lines.push(`- ${ts(a.t0)}~${ts(a.t1)} 【广告时段，跳过】`);
  }

  let used = lines.join('\n').length;
  const lite = opts.mode === 'lite';

  for (const sec of sections) {
    const blockHead = `\n## S${sec.idx} [${ts(sec.t0)}~${ts(sec.t1)}]`;
    const body = [];

    // 音频候选：按分数取前 N，保持时间顺序（短段多给条目，长段控制体积）
    const cand = sec.items.filter(i => !i.ad).slice();
    const span = Math.max(30, sec.t1 - sec.t0);
    const topN = lite ? 4 : Math.max(4, Math.min(10, Math.ceil(span / 45)));
    const picked = cand
      .map(i => ({ ...i }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .sort((a, b) => a.t - b.t);
    for (const i of picked) {
      const tag = i.types.length ? i.types.slice(0, 2).join('/') : '叙述';
      const cut = isLatinText(i.text) ? 220 : 110;
      const text = i.text.length > cut ? i.text.slice(0, cut - 2) + '…' : i.text;
      body.push(`- [${ts(i.t)}|音频|${tag}] ${text}`);
    }
    // 画面块：每段最多 4 块
    const ocrPick = sec.ocr.slice(0, lite ? 2 : 4);
    for (const b of ocrPick) {
      const txt = b.lines.join(' / ');
      body.push(`- [${ts(b.t0)}~${ts(b.t1)}|画面] ${txt.length > 160 ? txt.slice(0, 158) + '…' : txt}`);
    }
    const cx = crossCheck(sec);
    if (cx.length) body.push(`- 【交叉印证】${cx.join('、')}`);

    const seg = blockHead + '\n' + body.join('\n');
    if (used + seg.length > budget) {
      opts.truncated = true;
      opts.coveredUntil = sec.t0;
      lines.push('\n## （后续内容超出单次预算，已截断；用 --from=' + Math.floor(sec.t0) + ' 继续处理剩余部分）');
      break;
    }
    used += seg.length;
    lines.push(seg);
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------- 通用来源：本地文件 / 非B站站点 */
/* 本机无 ffmpeg → 不走音视频合并。策略：
   ① 有 progressive（音视频同体的 mp4）时只下一次，转写与抽帧共用同一文件；
   ② 全 DASH 时分别下「最佳音频」给 whisper、「最低清视频」给 OCR —— 本来就要两样东西，不需要合并。 */

const PYEXE = process.env.PYTHON_EXE || 'C:/Users/wumengbing/.workbuddy/binaries/python/envs/default/Scripts/python.exe';

function isBiliUrl(u) {
  return /bilibili\.com|b23\.tv|bili2233\.cn|acg\.tv/i.test(String(u || ''));
}

function slugify(t) {
  const s = String(t || 'video').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return (s || 'video').slice(0, 50);
}

function parseTsTok(tok) {
  const p = String(tok).replace(',', '.').split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
}

/* VTT / SRT / YouTube json3 之前已统一成 vtt，这里只吃文本格式 */
function parseSubText(txt) {
  const s = String(txt || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const cues = [];

  // JSON 系：YouTube json3 / B站 body
  const head = s.trim().slice(0, 1);
  if (head === '{' || head === '[') {
    try {
      const d = JSON.parse(s);
      const ev = Array.isArray(d) ? d : (d.events || (d.body ? d.body.map(x => ({ tStartMs: x.from * 1000, dDurationMs: (x.to - x.from) * 1000, segs: [{ utf8: x.content }] })) : null));
      if (ev) {
        for (const e of ev) {
          const raw = e.segs ? e.segs.map(x => x.utf8 || '').join('') : String(e.content || '');
          const text = stripHtml(String(raw).replace(/\n/g, ' '));
          if (!text) continue;
          const t = (e.tStartMs || 0) / 1000;
          const dur = (e.dDurationMs || 0) / 1000;
          if (cues.length && text.startsWith(cues[cues.length - 1].text)) {
            cues[cues.length - 1] = { t: cues[cues.length - 1].t, e: t + dur, text };
          } else {
            cues.push({ t, e: t + dur, text });
          }
        }
        if (cues.length) return cues;
      }
    } catch (e) { /* 不是合法 JSON，继续按文本解析 */ }
  }

  const blocks = s.split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n');
    let ti = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].includes('-->')) { ti = i; break; }
    if (ti < 0) continue;
    const m = lines[ti].match(/^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!m) continue;
    const t = parseTsTok(m[1]), e = parseTsTok(m[2]);
    const text = stripHtml(lines.slice(ti + 1).join(' '));
    if (!text) continue;
    // YouTube 自动字幕是滚动累加式：新行以旧行为前缀 → 直接替换，避免整段重复
    if (cues.length && text.startsWith(cues[cues.length - 1].text)) {
      cues[cues.length - 1] = { t: cues[cues.length - 1].t, e, text };
    } else if (cues.length && cues[cues.length - 1].text === text) {
      cues[cues.length - 1].e = e;
    } else {
      cues.push({ t, e, text });
    }
  }
  return cues;
}

function runCapture(bin, argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, argv, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '';
    const tm = setTimeout(() => { try { p.kill(); } catch (e) {} reject(new Error('执行超时')); }, timeoutMs || 600000);
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => {
      clearTimeout(tm);
      if (code === 0) resolve(out); else reject(new Error((err || out).slice(-300) || ('退出码 ' + code)));
    });
    p.on('error', e => { clearTimeout(tm); reject(e); });
  });
}

async function probeMedia(file) {
  try {
    const out = await runCapture(PYEXE, [path.join(__dirname, 'probe_media.py'), file], 60000);
    return JSON.parse(out.trim().split('\n').pop());
  } catch (e) { return { ok: false, duration: 0, error: e.message }; }
}

function pickRemoteSub(info) {
  const norm = (obj, kind) => Object.entries(obj || {}).map(([lan, arr]) => ({
    lan, kind, url: (arr || []).find(x => /vtt|srt|json3|json/.test(x.ext || ''))?.url || (arr || [])[0]?.url
  })).filter(x => x.url);
  const manual = norm(info.subtitles, '人工字幕');
  const auto = norm(info.automatic_captions || info.auto_captions, '自动字幕');
  const all = [...manual, ...auto];
  const score = x => {
    const l = (x.lan || '').toLowerCase();
    let sc = x.kind === '人工字幕' ? 100 : 0;
    if (/^zh(-|_)?(hans|cn|)$/.test(l) || l === 'zh') sc += 50;
    else if (/^zh/.test(l)) sc += 40;
    else if (/^en/.test(l)) sc += 25;
    else sc += 5;
    return sc;
  };
  const best = all.sort((a, b) => score(b) - score(a))[0];
  return best && score(best) >= 20 ? best : null;
}

/* 站点字幕：交给 yt-dlp 下载（直链常需签名/Cookie），拿到 json3/vtt/srt 再自行解析 */
async function ytDlpSubtitles(url, workDir) {
  try {
    await runCapture(PYEXE, ['-m', 'yt_dlp', '--no-playlist', '--no-warnings', '--skip-download',
      '--write-subs', '--write-auto-subs',
      '--sub-langs', 'zh-Hans,zh-CN,zh-Hant,zh-TW,zh,en.*,en',
      '--sub-format', 'json3/vtt/srt/best',
      '-o', path.join(workDir, 'sub.%(ext)s'), url], 240000);
  } catch (e) {
    /* 某些语种不存在时 yt-dlp 会非 0 退出，但已下到的字幕仍可用，继续读文件 */
    const any = fs.readdirSync(workDir).some(f => /^sub\..+\.(json3|vtt|srt)$/i.test(f));
    if (!any) return null;
  }

  const files = fs.readdirSync(workDir).filter(f => /^sub\..+\.(json3|vtt|srt)$/i.test(f));
  if (!files.length) return null;
  const score = f => {
    const lan = (f.split('.')[1] || '').toLowerCase();
    let sc = 0;
    if (/^zh/.test(lan)) sc += 50; else if (/^en/.test(lan)) sc += 30;
    if (/\.json3$/i.test(f)) sc += 5;
    if (/orig|auto/.test(lan)) sc -= 3;     // 人工字幕优先
    return sc;
  };
  files.sort((a, b) => score(b) - score(a));
  for (const f of files.slice(0, 3)) {
    try {
      const cs = parseSubText(fs.readFileSync(path.join(workDir, f), 'utf8'));
      if (cs.length) return { cues: cs, label: f.split('.').slice(1, -1).join('.').replace(/^([a-zA-Z]+)-\1$/, '$1') };
    } catch (e) { /* 换下一个 */ }
  }
  return null;
}

function pickFormats(info) {
  const all = (info.formats || []).filter(f => f.url);
  if (!all.length) return { single: null, video: null, audio: null };

  // 直链优先（HLS/DASH 分片下载慢且易断，仅在无直链时退回）
  const isDirect = f => !/m3u8|dash|mpd|frag/i.test(String(f.protocol || 'https'));
  const direct = all.filter(isDirect);
  const pool = direct.length ? direct : all;

  const hasA = f => !!f.acodec && f.acodec !== 'none';
  const hasV = f => !!f.vcodec && f.vcodec !== 'none';
  const size = f => f.filesize || f.filesize_approx || (f.tbr ? f.tbr * 1e5 : 0);
  const mp4First = arr => {
    const m = arr.filter(f => f.ext === 'mp4');
    return m.length ? m : arr;
  };

  // ① 音视频同体：只下一次，转写与抽帧共用（最省流量与时间）
  const prog = pool.filter(f => hasA(f) && hasV(f));
  if (prog.length) {
    const base = mp4First(prog);
    const small = base.filter(f => (f.height || 0) > 0 && (f.height || 0) <= 480)
      .sort((a, b) => (b.height || 0) - (a.height || 0));   // 480p 优先，画面文字才看得清
    const pick = small[0] || base.slice().sort((a, b) => size(a) - size(b))[0];
    return { single: pick, video: pick, audio: pick };
  }

  // ② 全 DASH：分别下音频（给 whisper）与视频（给 OCR），本来就要两样，无需合并
  const auds = pool.filter(f => hasA(f) && !hasV(f));
  const audio = auds.filter(f => f.ext === 'm4a').sort((a, b) => (b.abr || 0) - (a.abr || 0))[0]
    || auds.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0] || null;

  const vids = pool.filter(f => hasV(f) && !hasA(f));
  const capped = vids.filter(f => (f.height || 0) > 0 && (f.height || 0) <= 480);
  const video = capped.sort((a, b) => (b.height || 0) - (a.height || 0))[0]
    || vids.sort((a, b) => (a.height || 99999) - (b.height || 99999))[0] || null;

  return { single: null, video: video || audio, audio: audio || video };
}

async function ytDlpDownload(url, outTpl, fmtId, label) {
  const argv = ['-m', 'yt_dlp', '--no-playlist', '--no-warnings', '--no-progress',
    '--retry', '2', '--socket-timeout', '20'];
  if (fmtId) argv.push('-f', fmtId);
  argv.push('-o', outTpl, url);
  await runCapture(PYEXE, argv, 1500000);
}

function findDownloaded(dir, stem) {
  const hit = fs.readdirSync(dir).filter(f => f.startsWith(stem + '.') && !/\.(part|ytdl)$/.test(f));
  if (!hit.length) return null;
  return path.join(dir, hit.sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0]);
}

async function remoteSource(url, args) {
  console.log(JSON.stringify({ progress: 'resolve', site: new URL(url).hostname, note: '非B站链接，走 yt-dlp 通用解析' }));

  let info;
  try {
    const out = await runCapture(PYEXE, ['-m', 'yt_dlp', '-J', '--no-playlist', '--no-warnings', '--socket-timeout', '20', url], 180000);
    info = JSON.parse(out.trim().split('\n').pop());
  } catch (e) {
    const msg = String(e.message || '');
    let tip = '';
    if (/login|sign in|cookies|account|confirm your age|private/i.test(msg)) tip = '（该视频需要登录，请提供浏览器 Cookie 后重试）';
    else if (/unsupported url|no suitable/i.test(msg)) tip = '（yt-dlp 不支持该站点）';
    throw new Error('解析失败：' + msg.slice(0, 200) + tip);
  }

  const title = args.title || info.title || 'video';
  const site = (info.extractor_key || info.extractor || new URL(url).hostname).toString();
  const workDir = path.join(ROOT, 'work', slugify(title) + '_' + String(info.id || '').slice(-8));
  fs.mkdirSync(workDir, { recursive: true });

  // 字幕优先（比转写快一个数量级，质量也更稳）
  // 字幕与媒体下载并行，互不阻塞
  const subTask = (async () => {
    if (!(info.subtitles || info.automatic_captions)) return null;
    const got = await ytDlpSubtitles(url, workDir);
    if (got && got.cues.length) return { cues: got.cues, note: '站点字幕(' + got.label + ')' };
    const sub = pickRemoteSub(info);
    if (!sub) return null;
    try {
      const r = await requestUrl(sub.url, { headers: { 'User-Agent': UA }, timeout: 30000 });
      const cs = parseSubText(r.text);
      return cs.length ? { cues: cs, note: `${sub.kind}(${sub.lan})` } : null;
    } catch (e) { return null; }
  })().catch(() => null);

  const fmts = pickFormats(info);
  if (!fmts.video && !fmts.audio) throw new Error('未找到可下载的视频/音频格式');

  let videoFile = null, audioFile = null;
  const dlTask = (async () => {
  if (fmts.single) {
    console.log(JSON.stringify({ progress: 'download', note: '下载低清合体流（转写与抽帧共用）' }));
    await ytDlpDownload(url, path.join(workDir, 'source.%(ext)s'), fmts.single.format_id, '视频');
    videoFile = findDownloaded(workDir, 'source');
    if (!videoFile) throw new Error('下载完成但未找到文件');
    audioFile = videoFile;
  } else {
    const jobs = [];
    if (fmts.video) jobs.push((async () => {
      await ytDlpDownload(url, path.join(workDir, 'video.%(ext)s'), fmts.video.format_id, '视频');
      videoFile = findDownloaded(workDir, 'video');
    })());
    if (fmts.audio && fmts.audio.format_id !== (fmts.video || {}).format_id) jobs.push((async () => {
      await ytDlpDownload(url, path.join(workDir, 'audio.%(ext)s'), fmts.audio.format_id, '音频');
      audioFile = findDownloaded(workDir, 'audio');
    })());
    const rs = await Promise.allSettled(jobs);
    const bad = rs.filter(r => r.status === 'rejected');
    if (!videoFile && !audioFile) throw new Error('音频与视频均下载失败：' + (bad[0] && bad[0].reason && bad[0].reason.message || ''));
    if (!audioFile) audioFile = videoFile;
    if (!videoFile) videoFile = audioFile;
  }
  })();

  const [subRes, dlRes] = await Promise.allSettled([subTask, dlTask]);
  const cues = subRes.status === 'fulfilled' && subRes.value ? subRes.value.cues : null;
  const subNote = subRes.status === 'fulfilled' && subRes.value ? subRes.value.note : '';
  if (dlRes.status === 'rejected') throw (dlRes.reason instanceof Error ? dlRes.reason : new Error(String(dlRes.reason)));

  const pa = await probeMedia(audioFile || videoFile);
  const pv = (videoFile && videoFile !== audioFile) ? await probeMedia(videoFile) : pa;
  const probe = {
    ok: !!(pa && pa.ok),
    audio: (pa && pa.audio) || 0,
    video: (pv && pv.video) || 0,
    duration: Math.max((pa && pa.duration) || 0, (pv && pv.duration) || 0)
  };
  const meta = {
    title, bvid: null, aid: null, pageNo: 1, pageCount: 1,
    duration: info.duration || probe.duration || 0,
    owner: info.uploader || info.channel || '未知',
    subtitles: [], audioUrls: [], videoUrls: [],
    expired: false, hasSessdata: false,
    site, siteLabel: `${site}${info.id ? ' ' + info.id : ''}`
  };
  if (subNote) meta.subNote = subNote;
  return { meta, workDir, audioFile, videoFile, cues, probe };
}

async function localSource(file, args) {
  if (!fs.existsSync(file)) throw new Error('本地文件不存在：' + file);
  const stem = path.basename(file, path.extname(file));
  const title = args.title || stem;
  const workDir = path.join(ROOT, 'work', slugify(title) + '_local');
  fs.mkdirSync(workDir, { recursive: true });

  let cues = null, subNote = '';
  if (args.sub) {
    if (!fs.existsSync(args.sub)) throw new Error('字幕文件不存在：' + args.sub);
    const cs = parseSubText(fs.readFileSync(args.sub, 'utf8'));
    if (cs.length) { cues = cs; subNote = '外部字幕(' + path.basename(args.sub) + ')'; }
  }
  const probe = await probeMedia(file);
  const meta = {
    title, bvid: null, aid: null, pageNo: 1, pageCount: 1,
    duration: probe.duration || 0, owner: '本地文件',
    subtitles: [], audioUrls: [], videoUrls: [],
    expired: false, hasSessdata: false,
    site: 'local', siteLabel: '本地文件 ' + path.basename(file)
  };
  if (subNote) meta.subNote = subNote;
  return { meta, workDir, audioFile: file, videoFile: file, cues, probe };
}

async function resolveSource(args) {
  if (args.file) return localSource(path.resolve(args.file), args);
  const url = await normalizeShortLink(cleanShareText(args.input));
  if (isBiliUrl(url)) {
    const meta = await fetchMeta(args.input, args.sessdata);
    const workDir = path.join(ROOT, 'work', `${meta.bvid || 'av' + meta.aid}_P${meta.pageNo}`);
    return { meta, workDir, audioFile: null, videoFile: null, cues: null };
  }
  return remoteSource(url, args);
}

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  if (!args.input && !args.file) {
    console.log(JSON.stringify({ ok: false, error: '缺少视频链接或本地文件（--file=）' }));
    process.exit(1);
  }

  const src = await resolveSource(args);
  const meta = src.meta;
  if (meta.expired) {
    console.log(JSON.stringify({
      ok: false, error: 'SESSDATA已过期，请更新Cookie',
      hint: '重新登录 bilibili.com → F12 → Application/Storage → Cookies → 复制 SESSDATA 值'
    }));
    process.exit(2);
  }

  const workDir = src.workDir;
  fs.mkdirSync(workDir, { recursive: true });

  /* --- ② 采集：音频与画面并行（互不阻塞，任一路失败只降级） --- */
  const audioTask = (async () => {
    if (src.probe && src.probe.ok && !src.probe.audio && !(src.cues && src.cues.length)) {
      return { frags: [], source: '无', note: '该文件不含音轨，已跳过语音转写', needMerge: false };
    }
    const sub = pickSubtitle(meta.subtitles);
    let frags = [], source = '无', note = '', needMerge = false;
    if (src.cues && src.cues.length) {
      frags = cuesToSentences(src.cues);
      source = src.meta.subNote || '官方字幕';
    } else if (sub && sub.url) {
      try {
        const cues = await fetchSubtitleCues(sub, args.sessdata);
        if (cues.length) { frags = cuesToSentences(cues); source = `官方字幕(${sub.lanDoc || sub.lan})`; }
      } catch (e) { note = '官方字幕下载失败：' + e.message; }
    }
    if (!frags.length) {
      if (!note) {
        note = src.audioFile
          ? '无可用字幕，已用本地语音转写'
          : (args.sessdata ? '该视频无可用字幕，已用本地语音转写' : '未提供 SESSDATA，官方字幕不可见，已用本地语音转写');
      }
      const audioPath = src.audioFile || path.join(workDir, 'audio.m4a');
      // 预热模型：与下载并行，不阻塞；只有真的要转写才加载
      postJSON(DAEMON_URL, '/warmup', {}, 60000).catch(() => {});
      if (!src.audioFile && (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1024)) {
        await downloadFirst(meta.audioUrls, audioPath, args.sessdata, '音频', args.dlparts || 4);
      }
      frags = await transcribeAudio(audioPath, workDir, args);
      needMerge = true;   // 转写片段很碎，先用画面字幕校正，再合并成句
      source = `本地语音转写(whisper-${args.model || 'small'}${LAST_LANG ? ',' + LAST_LANG : ''})`;
    }
    return { frags, source, note, needMerge };
  })().catch(e => ({ frags: [], source: '无', note: '音频采集失败：' + e.message, needMerge: false }));

  const ocrTask = (async () => {
    if (args.ocr === 'off') {
      return { blocks: [], frames: 0, skipped: true, note: '按 --ocr=off 跳过画面识别，仅用音频' };
    }
    if (src.probe && src.probe.ok && !src.probe.video) {
      throw new Error('该文件不含视频轨，无法做画面文字识别');
    }
    // ① 远程流式取帧：不必把整段视频拉下来（长视频可省十几分钟），失败再回退本地
    if (!src.videoFile && args.remote !== 'off' && meta.videoUrls && meta.videoUrls.length) {
      try {
        const r = await withRetry('远程画面取帧', 2, () => postJSON(OCR_URL, '/ocr', {
          url: meta.videoUrls[0],
          headers: 'Referer: https://www.bilibili.com/\r\nUser-Agent: ' + UA + '\r\n',
          max_frames: args.frames,
          duration: meta.duration || 0
        }, 300000));
        if (r && r.ok) { r.remote = true; return r; }
      } catch (e) {
        warn('远程取帧失败，回退到本地视频：' + e.message);
      }
    }
    // ② 回退：本地视频文件
    const videoPath = src.videoFile || path.join(workDir, 'video.mp4');
    if (!src.videoFile && (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 1024)) {
      await downloadFirst(meta.videoUrls, videoPath, args.sessdata, '视频', args.dlparts || 6);
    }
    const r = await withRetry('画面文字识别', 2, () => postJSON(OCR_URL, '/ocr', { path: videoPath, max_frames: args.frames }, 300000));
    if (!r.blocks) r.blocks = [];
    return r;
  })().catch(e => { warn('画面文字采集失败：' + e.message); return { blocks: [], frames: 0, error: e.message }; });

  const [aRes, oRes] = await Promise.all([audioTask, ocrTask]);
  if (!meta.duration) {
    const maxE = Math.max(0, ...aRes.frags.map(x => x.e || 0), ocr && ocr.duration || 0);
    if (maxE > 0) meta.duration = Math.round(maxE);
  }
  const audioSource = aRes.source;
  const audioWarn = aRes.note || '';
  const ocr = oRes;
  const ocrBlocked = ocr.skipped
    ? ''
    : (oRes.error
      ? '画面文字采集失败：' + oRes.error
      : ((oRes.blocks || []).length ? '' : '画面文字识别结果为空（可能是纯人像/纯黑画面）'));

  /* --- ③ 清洗 + 融合（画面字幕校正同音字、重复行剔除）+ 分段 --- */
  const ocrClean = sanitizeOcr(ocr.blocks || [], meta);
  const fused = fuse(ocrClean, aRes.frags);                       // 先按片段校正，命中率最高
  const merged = aRes.needMerge
    ? cuesToSentences(aRes.frags.map(s => ({ t: s.t, e: s.e, text: s.text })))
    : aRes.frags;
  const cleaned = cleanSentences(merged.length ? merged : aRes.frags);
  const sentencesFinal = dedupeSentences(cleaned.sentences);
  // 长视频分块：--from=N 只处理 N 秒之后的内容
  const fromSec = args.from || 0;
  const useSentences = fromSec > 0 ? sentencesFinal.filter(x => x.e >= fromSec) : sentencesFinal;
  const useBlocks = fromSec > 0 ? fused.blocks.filter(b => b.t1 >= fromSec) : fused.blocks;
  const sections = buildSections(useSentences, useBlocks);
  const digestOpts = { ...args };

  const audioInfo = {
    source: audioSource, count: sentencesFinal.length,
    hasTs: sentencesFinal.some(s => s.t > 0),
    adSegments: cleaned.adSegments, warn: audioWarn
  };
  const ocrInfo = { blocks: fused.blocks, frames: ocr.frames || 0, blocked: ocrBlocked, fixed: fused.fixed, skipped: !!ocr.skipped };

  const digest = buildDigest(meta, audioInfo, ocrInfo, sections, digestOpts);

  fs.writeFileSync(path.join(workDir, 'meta.json'), JSON.stringify(meta, null, 0), 'utf8');
  fs.writeFileSync(path.join(workDir, 'audio.json'), JSON.stringify({ source: audioSource, warn: audioWarn, sentences: sentencesFinal, adSegments: cleaned.adSegments }, null, 0), 'utf8');
  fs.writeFileSync(path.join(workDir, 'ocr.json'), JSON.stringify({ blocks: fused.blocks, frames: ocr.frames || 0, blocked: ocrBlocked, fixed: fused.fixed }, null, 0), 'utf8');
  fs.writeFileSync(path.join(workDir, 'digest.md'), digest, 'utf8');
  fs.writeFileSync(path.join(workDir, 'digest.json'), JSON.stringify({ meta, audioInfo, ocrInfo, sections }, null, 0), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    title: meta.title,
    site: meta.siteLabel || 'B站',
    bvid: meta.bvid, page: meta.pageNo,
    duration: ts(meta.duration),
    audio: { source: audioSource, sentences: sentencesFinal.length, warn: audioWarn || null },
    ocr: { blocks: fused.blocks.length, frames: ocr.frames || 0, blocked: ocrBlocked || null, fixed: fused.fixed, burnInDropped: fused.droppedBlocks, skipped: !!ocr.skipped, source: ocr.remote ? '远程流式取帧' : (ocr.skipped ? '已跳过' : '本地视频'), elapsed: ocr.elapsed || null },
    ads: cleaned.adSegments.length,
    sections: sections.length,
    covered: {
      from: ts(fromSec),
      until: ts(digestOpts.truncated ? digestOpts.coveredUntil : (sections.length ? sections[sections.length - 1].t1 : 0)),
      total: ts(meta.duration),
      truncated: !!digestOpts.truncated
    },
    chars: digest.length,
    digest: path.join(workDir, 'digest.md'),
    elapsed: ((Date.now() - t0) / 1000).toFixed(1) + 's',
    warn: WARN
  }, null, 1));
}

/* 供自测脚本复用（KB_UNIT=1 时不跑真实流水线） */
if (process.env.KB_UNIT === '1') {
  module.exports = {
    buildSections, buildDigest, cleanSentences, fuse, sanitizeOcr,
    cuesToSentences, crossCheck, dedupeSentences, ts, adScore, classify
  };
} else {
  main().catch(e => {
    console.log(JSON.stringify({ ok: false, error: e.message, warn: WARN }));
    process.exit(1);
  });
}
