#!/usr/bin/env node
'use strict';
/**
 * check_notes.js —— 笔记质量闸门（渲染前的硬校验）
 * 用法：node check_notes.js work/<id>/notes.json [--digest=work/<id>/digest.md] [--json]
 *
 * 退出码：0 通过（可能有 warning）；2 有 error，禁止渲染交付。
 * 设计原则：只查「机器能判定的客观事实」，不评价写得好不好。
 *   —— 主观质量靠 SKILL.md 的写作红线，客观缺陷靠这里拦住。
 *
 * 字段语义：
 *   text  = 原话    ：忠于讲者原意，可以长（上限 240 字）
 *   plain = 简易理解：用初中生能懂的话讲清楚，且不丢关键数字与限定条件
 */
const fs = require('node:fs');

const BLACK_TERM = ['赋能', '抓手', '闭环', '颗粒度', '对齐', '落地', '打法', '组合拳', '生态位', '心智'];
const MARKS = ['⭐', '💡', '⚠️', '⚠'];
const CONFS = ['✅', '🤔', '📌'];
const SRCS = ['音频', '画面', '交叉印证'];

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.log(JSON.stringify({ ok: false, error: '缺少 notes.json 路径' })); process.exit(2); }
const digestArg = args.find(a => a.startsWith('--digest='));
const asJson = args.includes('--json');

const notes = JSON.parse(fs.readFileSync(file, 'utf8'));
const E = [];   // error 阻断交付
const W = [];   // warning 提示但不拦

const ts2sec = (s) => {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const a = +m[1], b = +m[2], c = m[3] === undefined ? null : +m[3];
  // m:ss 时 m 是分钟；h:mm:ss 时 a 是小时。分/秒都必须 < 60，否则是格式错误
  if (c === null) { if (b >= 60) return null; return a * 60 + b; }
  if (b >= 60 || c >= 60) return null;
  return a * 3600 + b * 60 + c;
};

/* ---------- 文本工具 ---------- */
const norm = (s) => String(s || '').replace(/[\s，。；、,.;:：·「」『』（）()【】!！?？"'""'']/g, '');

/* 字符二元组集合：用于判断"是否只是换词重排" */
function bigrams(s) {
  const t = norm(s);
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

/* 抽取数量：数字 + 单位（% / 倍 / 万 / 亿），中文数字先归一化成阿拉伯数字，
   这样「两倍」和「2 倍」算同一个数，数字保真检查才有意义 */
const CN_NUM = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
function nums(s) {
  const t = String(s || '')
    .replace(/翻倍/g, '两倍')
    .replace(/一倍/g, '两倍')            // 口语「提升一倍」= 2 倍
    .replace(/([一二两三四五六七八九十])倍/g, (m, a) => CN_NUM[a] + '倍');
  const out = new Set();
  const re = /(\d+(?:\.\d+)?)\s*(%|倍|万|亿)?/g;
  let m;
  while ((m = re.exec(t))) out.add(m[1] + (m[2] || ''));
  return out;
}

/* ---------- 1. 顶层字段 ---------- */
if (!notes.title) E.push('缺 title');
if (!notes.tldr) E.push('缺 tldr（一句话看懂）');
else if (notes.tldr.length < 20 || notes.tldr.length > 110) W.push(`tldr 长度 ${notes.tldr.length}，建议 40–70 字`);
if (!notes.coverage || !notes.coverage.audio) W.push('缺 coverage.audio（用户无法判断可信度）');

/* ---------- 2. 主题与条数 ---------- */
const topics = Array.isArray(notes.topics) ? notes.topics : [];
if (!topics.length) E.push('topics 为空');
if (topics.length < 3) W.push(`主题仅 ${topics.length} 个，短视频可接受，长视频建议 4–8 个`);
if (topics.length > 10) E.push(`主题 ${topics.length} 个，超过 10 个说明没做归纳，请合并`);

const durSec = ts2sec((notes.duration || '0:00').replace(/^0(\d)/, '$1'));

let totalItems = 0;
topics.forEach((t, ti) => {
  const tag = `主题 ${ti + 1}`;
  if (!t.title) E.push(`${tag} 缺 title`);
  if (!t.range) E.push(`${tag} 缺 range（起止时间戳）`);
  else if (ts2sec(String(t.range).split(/[–\-~]/)[0]) === null) E.push(`${tag} range 格式错误：${t.range}`);
  if (!t.summary) E.push(`${tag} 缺 summary（本段小结）`);
  else if (t.summary.length < 15 || t.summary.length > 100) W.push(`${tag} summary 长度 ${t.summary.length}，建议 30–60 字`);

  const items = Array.isArray(t.items) ? t.items : [];
  if (!items.length) E.push(`${tag} 没有知识点`);
  if (items.length > 8) W.push(`${tag} 有 ${items.length} 条，偏多，考虑拆主题`);
  totalItems += items.length;

  const seen = new Set();
  items.forEach((it, ii) => {
    const p = `${tag} 第 ${ii + 1} 条`;
    const sec = ts2sec(it.ts);
    if (sec === null) E.push(`${p} 时间戳格式错误：${it.ts}`);
    else if (durSec && sec > durSec + 5) E.push(`${p} 时间戳 ${it.ts} 超出视频时长`);

    /* 原话：忠于原意，允许长，但要有下限 */
    if (!it.text) E.push(`${p} 缺原话（text）`);
    else {
      if (it.text.length < 12) E.push(`${p} 原话只有 ${it.text.length} 字，不成句`);
      if (it.text.length > 240) E.push(`${p} 原话 ${it.text.length} 字，超过 240 字请拆成两条`);
      else if (it.text.length > 160) W.push(`${p} 原话 ${it.text.length} 字，手机端偏长，建议 ≤120`);
    }

    /* 简易理解：既讲得明白，又不丢信息，两头都要管 */
    if (!it.plain) E.push(`${p} 缺简易理解（plain）`);
    else {
      const len = it.plain.length;
      if (len < 15) E.push(`${p} 简易理解只有 ${len} 字，没讲明白`);
      else if (len > 160) E.push(`${p} 简易理解 ${len} 字，超过 160 字就不是"讲明白"了`);
      else if (len < 30 || len > 140) W.push(`${p} 简易理解 ${len} 字，建议 30–140 字`);

      for (const b of BLACK_TERM) {
        if (it.plain.includes(b)) E.push(`${p} 简易理解含黑话「${b}」，没翻译成人话`);
      }
      const seps = (it.plain.match(/[，；。！？、,;!?]/g) || []).length;
      if (len > 60 && seps < 2) W.push(`${p} 简易理解偏长且没有断句（${seps} 个分隔符）`);

      if (it.text) {
        /* ① 换词重排：与原话重合度过高 = 没有真正解释 */
        const sim = overlapRatio(bigrams(it.plain), bigrams(it.text));
        if (sim >= 0.85) {
          E.push(`${p} 简易理解与原话重合度 ${(sim * 100).toFixed(0)}%，只是换词重排，没有真正讲明白`);
        }
        /* ② 数字保真：原话里的关键数字不能全丢；简易理解不能凭空造数字 */
        const tn = nums(it.text), pn = nums(it.plain);
        if (tn.size) {
          const lost = [...tn].filter(x => !pn.has(x));
          if (lost.length === tn.size) {
            W.push(`${p} 原话中的数字（${[...tn].slice(0, 4).join('、')}）在简易理解里一个都没有，可能漏了关键条件`);
          }
        }
        const invented = [...pn].filter(x => !tn.has(x));
        if (invented.length) {
          E.push(`${p} 简易理解出现原话里没有的数字（${invented.slice(0, 3).join('、')}），是凭空添加`);
        }
      }
    }

    /* 小标题：每条都要有，且要短 */
    if (!it.title) E.push(`${p} 缺小标题（title）`);
    else {
      const tl = it.title.length;
      if (tl < 2) E.push(`${p} 小标题只有 ${tl} 字，无法识别`);
      else if (tl > 20) E.push(`${p} 小标题 ${tl} 字，超过 20 字就不是「小标题」了`);
      else if (tl > 14) W.push(`${p} 小标题 ${tl} 字，建议 ≤14 字`);
      const seenTitles = seen.has('T:' + it.title);
      if (seenTitles) E.push(`${p} 小标题与同主题内其他条目重复：${it.title}`);
    }

    if (!MARKS.some(m => String(it.mark || '').startsWith(m.slice(0, 1)))) E.push(`${p} mark 非法：${it.mark}`);
    if (!CONFS.some(c => String(it.conf || '').startsWith(c))) E.push(`${p} conf 非法：${it.conf}`);
    if (it.src && !SRCS.includes(it.src)) E.push(`${p} src 只能是 ${SRCS.join('/')}：${it.src}`);

    const key = String(it.text || '').replace(/[\s，。；、,.;:：·]/g, '').slice(0, 24);
    if (key && seen.has(key)) E.push(`${p} 与同主题内其他条目重复：${key.slice(0, 14)}…`);
    seen.add(key);
    if (it.title) seen.add('T:' + it.title);
  });
});

if (totalItems < 10 && durSec && durSec > 600) E.push(`仅 ${totalItems} 条知识点，10 分钟以上视频不该这么少`);
if (totalItems > 40) W.push(`共 ${totalItems} 条，偏多，考虑精简模式或合并同类`);

/* ---------- 3. 交叉核对 digest（时间戳是否真的存在） ---------- */
let digestOk = null;
if (digestArg) {
  const dp = digestArg.slice('--digest='.length);
  if (fs.existsSync(dp)) {
    const dg = fs.readFileSync(dp, 'utf8');
    const stamps = new Set();
    for (const m of dg.matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g)) {
      const s = ts2sec(m[1]);
      if (s !== null) stamps.add(s);
    }
    const all = [];
    topics.forEach(t => (t.items || []).forEach(it => { const s = ts2sec(it.ts); if (s !== null) all.push(s); }));
    const miss = all.filter(s => ![...stamps].some(x => Math.abs(x - s) <= 12));
    if (stamps.size && miss.length) {
      W.push(`${miss.length}/${all.length} 条时间戳在素材包中找不到 ±12s 内的锚点（可能是推算的，请核对）`);
    }
    digestOk = { anchors: stamps.size, checked: all.length, unmatched: miss.length };
  }
}

/* ---------- 4. 广告段与覆盖 ---------- */
if (Array.isArray(notes.ads)) {
  for (const a of notes.ads) if (!a.t0 || !a.t1) E.push('ads 项缺 t0/t1');
}

const report = {
  ok: E.length === 0,
  errors: E.slice(0, 30),
  warnings: W.slice(0, 20),
  stats: {
    topics: topics.length,
    items: totalItems,
    avgItemsPerTopic: topics.length ? +(totalItems / topics.length).toFixed(1) : 0,
    duration: notes.duration || '',
    digestCheck: digestOk
  }
};

if (asJson) console.log(JSON.stringify(report, null, 1));
else {
  console.log((E.length ? 'FAIL' : 'PASS') + ` 主题 ${topics.length} / 知识点 ${totalItems}`);
  E.forEach(x => console.log('  ✗ ' + x));
  W.forEach(x => console.log('  ! ' + x));
}
process.exit(E.length ? 2 : 0);
