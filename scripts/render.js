#!/usr/bin/env node
'use strict';
/**
 * render.js —— 把紧凑 notes.json 渲染成手机友好的知识笔记（Markdown + 可选 HTML）
 * 用法：node render.js work/<id>/notes.json [--lite] [--rag] [--out=x.md] [--html]
 *
 * notes.json 结构：
 * {
 *   title, url, bvid, page, duration, up, tldr,
 *   coverage: { audio, ocr, missing: [] },
 *   ads: [{ t0, t1 }],
 *   topics: [{ no, title, range, summary,
 *              items: [{ title, mark, conf, text, plain, ts, src, conflict, note }] }],
 * }
 *
 * 版式约定（Markdown 与 HTML 一致）：
 *   ① 每个知识点有独立小标题（items[].title），标题层用「主题 → 条目 → 小标题」三级从属
 *   ② 原话 = 淡粉底块；简易理解 = 淡蓝底块
 *   ③ 内容地图表格在「条数」后追加「小标题」一列
 *   ④ 思维导图大纲用括号树（（1）（1.1））表示记忆顺序
 *   ⑤ 关键结论速览单独成块美化
 */
const fs = require('node:fs');
const path = require('node:path');

function normMark(m) {
  if (!m) return '⭐';
  if (m.startsWith('💡')) return '💡';
  if (m.startsWith('⚠')) return '⚠️';
  return '⭐';
}
function normConf(c) {
  if (!c) return '✅';
  if (c.startsWith('🤔')) return '🤔';
  if (c.startsWith('📌')) return '📌';
  return '✅';
}
function clean(v) { return String(v == null ? '' : v).trim(); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
/* 小标题：没有就用原话首句兜底 */
function itemTitle(it) {
  const t = clean(it.title);
  if (t) return t;
  const s = clean(it.text);
  const cut = s.split(/[，,。；;：:]/)[0];
  return (cut || s).slice(0, 18);
}
function head(s) {
  const t = clean(s);
  const i = t.search(/[。！？；!?;]/);
  return i > 0 ? t.slice(0, i + 1) : t;
}
function topicItems(t, lite) {
  return (t.items || []).filter(it => !(lite && it.low));
}
/* 方框装饰线（Markdown 端用制表符画框） */
function box(label, body, fixedW) {
  const text = clean(body);
  const w = fixedW || Math.max(28, Math.min(56, text.length + 4));
  const bar = '─'.repeat(w);
  const lines = [];
  for (let i = 0; i < text.length; i += w) lines.push(text.slice(i, i + w));
  return [`╭─ ${label} ${'─'.repeat(Math.max(2, w - label.length - 3))}`,
    ...lines.map(l => '│ ' + l),
    `╰${bar}`].join('\n');
}

/* ---------------------------------------------------------------- Markdown */
function renderMd(n, lite) {
  const L = [];
  const push = (...xs) => L.push(...xs);
  const topics = (n.topics || []).filter(t => Array.isArray(t.items) && t.items.length);
  const totalItems = topics.reduce((a, t) => a + topicItems(t, lite).length, 0);

  push(`# ${clean(n.title) || '视频笔记'}`, '');

  const meta = [];
  if (n.bvid) meta.push(`BV ${n.bvid}`.replace('BV BV', 'BV'));
  if (n.page && n.page !== 1) meta.push(`P${n.page}`);
  if (n.duration) meta.push(`时长 ${n.duration}`);
  if (n.up) meta.push(`UP ${n.up}`);
  if (meta.length) push(`> ${meta.join(' · ')}`, '');
  if (n.tldr) push(`**一句话看懂**　${clean(n.tldr)}`, '');

  const cov = n.coverage || {};
  const covLine = [];
  if (cov.audio) covLine.push(`音频：${cov.audio}`);
  if (cov.ocr) covLine.push(`画面：${cov.ocr}`);
  if (covLine.length) push(`**采集情况**　${covLine.join('　|　')}`, '');
  if (cov.missing && cov.missing.length) push(`⚠️ 缺失说明：${cov.missing.join('；')}`, '');

  if (n.ads && n.ads.length) {
    push('**广告时段**', '');
    for (const a of n.ads) push(`- ${a.t0}–${a.t1}　【广告时段，跳过】`);
    push('');
  }

  /* ── 内容地图：条数后追加「小标题」列 ── */
  if (topics.length) {
    push('## 内容地图', '', `共 ${topics.length} 个主题 / ${totalItems} 条知识点`, '');
    push('| # | 主题 | 时间段 | 条数 | 小标题 |', '|---|------|--------|------|--------|');
    topics.forEach((t, k) => {
      const items = topicItems(t, lite);
      const titles = items.map(it => `▌${itemTitle(it)}`).join('　');
      push(`| ${k + 1} | ${clean(t.title).replace(/\|/g, '／')} | ${clean(t.range) || '—'} | ${items.length} | ${titles} |`);
    });
    push('');
  }

  /* ── 关键结论速览：只收 ⭐，做成表格便于扫读 ── */
  const key = [];
  topics.forEach((t, k) => {
    let kc = 0;
    for (const it of topicItems(t, lite)) {
      if (normMark(it.mark) === '⭐') {
        kc++;
        key.push({ topic: clean(t.title), no: `${k + 1}.${kc}`, title: itemTitle(it), text: clean(it.plain) || clean(it.text) });
      }
    }
  });
  if (key.length) {
    push('## 关键结论速览', '', `_共 ${key.length} 条 ⭐ 核心结论，按主题顺序排列，可先扫这一节抓主线_`, '');
    push('| 主题 | 核心结论 |', '|------|----------|');
    for (const k of key) {
      const s = k.text.length > 56 ? k.text.slice(0, 54) + '…' : k.text;
      push(`| ${k.no} | **▌${k.title}**　${s} |`);
    }
    push('');
  }

  push('---', '');

  /* ── 正文：主题 → 条目 → 小标题 ── */
  topics.forEach((t, k) => {
    const items = topicItems(t, lite);
    if (!items.length) return;
    push(`## ${k + 1}. ${clean(t.title)}`, '');
    const sub = [];
    if (t.range) sub.push(`\`${clean(t.range)}\``);
    sub.push(`${items.length} 条`);
    push(sub.join('　·　'), '');
    if (t.summary) push(`> **本段小结**　${clean(t.summary)}`, '');

    items.forEach((it, j) => {
      push(`### ${k + 1}.${j + 1}　${normMark(it.mark)} ${normConf(it.conf)}${it.conflict ? '　【信息冲突】' : ''}`, '');
      push(`**▌${itemTitle(it)}**`, '');
      const bw = Math.max(30, Math.min(58, Math.max(clean(it.text).length, clean(it.plain).length) + 2));
      push(box('原话', it.text, bw), '');
      const tsLine = [];
      if (it.ts) tsLine.push(`\`${clean(it.ts)}\``);
      if (it.src) tsLine.push(it.src);
      if (tsLine.length) push(`⏱ **音频时间**　${tsLine.join('　·　')}`, '');
      if (it.plain && !lite) push(box('简易理解', it.plain, bw), '');
      if (it.note) push(`📎 ${clean(it.note)}`, '');
    });
    push('');
  });

  /* ── 思维导图大纲：括号树，表示记忆顺序 ── */
  push('---', '');
  push('## 思维导图大纲', '', `_◆ 为全片根节点；括号内是记忆顺序编号：（1）主题 →（1.1）知识点，逐级展开，按顺序记忆_`, '');
  push(`◆ ${clean(n.title) || '视频笔记'}`);
  topics.forEach((t, k) => {
    const items = topicItems(t, lite);
    if (!items.length) return;
    push(`　（${k + 1}）${clean(t.title)}${t.range ? '　' + clean(t.range) : ''}`);
    items.forEach((it, j) => {
      push(`　　（${k + 1}.${j + 1}）▌${itemTitle(it)}　${normMark(it.mark)}`);
    });
  });
  push('');
  push('---', '');
  push('> 素材来自视频，仅限个人学习，禁止商用。');
  push('');
  return L.join('\n');
}

/* ---------------------------------------------------------------- HTML */
function renderHtml(n, lite) {
  const topics = (n.topics || []).filter(t => Array.isArray(t.items) && t.items.length);
  const totalItems = topics.reduce((a, t) => a + topicItems(t, lite).length, 0);

  const key = [];
  topics.forEach((t, k) => {
    let kc = 0;
    for (const it of topicItems(t, lite)) {
      if (normMark(it.mark) === '⭐') {
        kc++;
        key.push({ topic: clean(t.title), no: `${k + 1}.${kc}`, title: itemTitle(it), text: clean(it.plain) || clean(it.text) });
      }
    }
  });

  const meta = [];
  if (n.bvid) meta.push(`BV ${n.bvid}`.replace('BV BV', 'BV'));
  if (n.page && n.page !== 1) meta.push(`P${n.page}`);
  if (n.duration) meta.push(`时长 ${n.duration}`);
  if (n.up) meta.push(`UP ${n.up}`);

  const cov = n.coverage || {};
  const covLine = [];
  if (cov.audio) covLine.push(`音频：${cov.audio}`);
  if (cov.ocr) covLine.push(`画面：${cov.ocr}`);

  const mapRows = topics.map((t, k) => {
    const items = topicItems(t, lite);
    return `<tr>
  <td class="num">${k + 1}</td>
  <td class="tt">${esc(t.title)}</td>
  <td class="rg">${esc(t.range || '')}</td>
  <td class="ct">${items.length}</td>
  <td class="st">${items.map(it => `<span class="chip">${esc(itemTitle(it))}</span>`).join('')}</td>
</tr>`;
  }).join('\n');

  const keyCards = key.map(k => `<div class="kcard">
  <div class="kh"><span class="kn">${esc(k.no)}</span><span class="kt">${esc(k.title)}</span></div>
  <div class="kb">${esc(k.text)}</div>
</div>`).join('\n');

  const topicHtml = topics.map((t, k) => {
    const items = topicItems(t, lite);
    if (!items.length) return '';
    const body = items.map((it, j) => {
      const core = normMark(it.mark) === '⭐';
      return `<div class="item${core ? ' core' : ''}">
  <div class="ihead">
    <span class="idx">${k + 1}.${j + 1}</span>
    <span class="mk">${normMark(it.mark)} ${normConf(it.conf)}</span>
    ${it.conflict ? '<span class="flag">信息冲突</span>' : ''}
  </div>
  <div class="sub">▌${esc(itemTitle(it))}</div>
  <div class="quote"><span class="lab">原话</span><p>${esc(it.text)}</p></div>
  <div class="time">⏱ 音频时间　${esc(it.ts || '—')}${it.src ? '　·　' + esc(it.src) : ''}</div>
  ${(it.plain && !lite) ? `<div class="plain"><span class="lab">简易理解</span><p>${esc(it.plain)}</p></div>` : ''}
  ${it.note ? `<div class="note">📎 ${esc(it.note)}</div>` : ''}
</div>`;
    }).join('\n');
    return `<section class="topic">
  <div class="thead">
    <span class="tno">${k + 1}</span>
    <div class="ttx"><h2>${esc(t.title)}</h2><span class="trg">${esc(t.range || '')} · ${items.length} 条</span></div>
  </div>
  ${t.summary ? `<div class="summary"><span class="slab">本段小结</span>${esc(t.summary)}</div>` : ''}
  ${body}
</section>`;
  }).join('\n');

  const outlineHtml = topics.map((t, k) => {
    const items = topicItems(t, lite);
    if (!items.length) return '';
    return `<li><span class="on">（${k + 1}）</span>${esc(t.title)}
  <ul>${items.map((it, j) => `<li><span class="on">（${k + 1}.${j + 1}）</span><span class="osub">▌${esc(itemTitle(it))}</span> <span class="omk">${normMark(it.mark)}</span></li>`).join('')}</ul></li>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(n.title || '视频笔记')}</title>
<style>
:root{
  --bg:#f4f6f9; --card:#ffffff; --ink:#15181f; --ink2:#4b5162; --ink3:#838a9d;
  --line:#e4e7ee; --line2:#eef0f5;
  --accent:#2f6df6; --accent-soft:#e9f0ff;
  --quote-bg:#fdf2f6; --quote-line:#f3b8cd; --quote-lab:#c2185b;
  --plain-bg:#eef4fd; --plain-line:#b9cff5; --plain-lab:#1a5fd0;
  --warn-bg:#fff7e6; --warn-line:#ffd591; --warn-ink:#a15c00;
  --core:#fffaf0; --core-line:#f0d9a8;
  --radius:14px; --shadow:0 1px 2px rgba(16,24,40,.05),0 10px 28px rgba(16,24,40,.06);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0e1014; --card:#161920; --ink:#e8eaf1; --ink2:#b2b8c8; --ink3:#828a9c;
    --line:#242832; --line2:#1d2129;
    --accent:#6c9bff; --accent-soft:#17233c;
    --quote-bg:#2a1a21; --quote-line:#5d3346; --quote-lab:#f28ab4;
    --plain-bg:#161f30; --plain-line:#2f4470; --plain-lab:#8fb4ff;
    --warn-bg:#2a2113; --warn-line:#5b4718; --warn-ink:#e5b567;
    --core:#241f14; --core-line:#4a3f1f;
    --shadow:0 1px 2px rgba(0,0,0,.35),0 10px 28px rgba(0,0,0,.28);
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-text-size-adjust:100%}
.wrap{max-width:800px;margin:0 auto;padding:20px 16px 72px}
header h1{font-size:25px;line-height:1.4;margin:4px 0 10px;letter-spacing:.2px}
.meta{color:var(--ink3);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 14px}
.tldr{background:var(--accent-soft);border-left:4px solid var(--accent);border-radius:12px;
  padding:14px 16px;margin:16px 0;font-size:16.5px}
.tldr b{color:var(--accent)}
.cov{font-size:13px;color:var(--ink2);margin:10px 0}
.warn{background:var(--warn-bg);border:1px solid var(--warn-line);color:var(--warn-ink);
  border-radius:10px;padding:10px 14px;font-size:14px;margin:12px 0}
h2.sect{font-size:19px;margin:34px 0 6px;padding:0 0 8px;border-bottom:2px solid var(--line);display:flex;align-items:center;gap:8px}
h2.sect::before{content:"";width:4px;height:18px;background:var(--accent);border-radius:2px;display:inline-block}
.hint{color:var(--ink3);font-size:12.5px;margin:6px 0 12px}

/* 内容地图 */
.tablewrap{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);overflow:hidden;margin:12px 0}
table.map{width:100%;border-collapse:collapse;font-size:14px}
table.map th{background:var(--accent-soft);color:var(--accent);font-weight:600;font-size:13px;
  text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
table.map td{padding:10px 12px;border-bottom:1px solid var(--line2);vertical-align:top}
table.map tr:last-child td{border-bottom:0}
td.num{width:34px;color:var(--accent);font-weight:700}
td.tt{font-weight:600}
td.rg{color:var(--ink3);font-size:13px;white-space:nowrap}
td.ct{color:var(--ink3);font-size:13px;white-space:nowrap}
td.st{color:var(--ink2);font-size:12.5px;line-height:1.9}
.chip{display:inline-block;border:1px solid var(--line);border-left:3px solid var(--accent);
  border-radius:6px;padding:1px 7px;margin:1px 4px 1px 0;background:var(--bg)}

/* 关键结论速览 */
.keys{display:grid;gap:10px;margin:12px 0}
.kcard{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);padding:12px 14px;border-left:4px solid var(--accent)}
.kh{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.kn{background:var(--accent);color:#fff;border-radius:6px;font-size:12px;font-weight:700;
  padding:1px 7px;letter-spacing:.3px}
.kt{font-weight:700;font-size:15px}
.kb{color:var(--ink2);font-size:14.5px}

/* 主题卡 */
.topic{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);padding:16px 16px 6px;margin:16px 0}
.thead{display:flex;gap:12px;align-items:flex-start}
.tno{flex:0 0 auto;width:30px;height:30px;border-radius:9px;background:var(--accent);color:#fff;
  display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px}
.ttx h2{font-size:18px;margin:2px 0 2px;padding:0;border:0}
.trg{color:var(--ink3);font-size:12.5px}
.summary{background:var(--bg);border:1px solid var(--line2);border-left:3px solid var(--accent);
  border-radius:8px;padding:9px 12px;margin:12px 0 4px;color:var(--ink2);font-size:14.5px}
.slab{font-weight:700;color:var(--ink);margin-right:6px}

/* 知识点盒 */
.item{border:1px solid var(--line);border-radius:12px;padding:12px 13px;margin:12px 0;background:var(--bg)}
.item.core{background:var(--core);border-color:var(--core-line)}
.ihead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.idx{background:var(--ink);color:var(--bg);border-radius:5px;font-size:12px;font-weight:700;padding:1px 7px}
.item.core .idx{background:var(--accent);color:#fff}
.mk{font-size:13px;color:var(--ink2)}
.flag{font-size:11.5px;padding:1px 8px;border-radius:999px;background:var(--warn-bg);
  color:var(--warn-ink);border:1px solid var(--warn-line)}
.sub{display:inline-block;border:1px solid var(--line);border-left:4px solid var(--ink);
  border-radius:7px;padding:3px 10px;margin:2px 0 10px;font-weight:700;font-size:14.5px;background:var(--card)}
.item.core .sub{border-left-color:var(--accent)}
.quote{background:var(--quote-bg);border:1px solid var(--quote-line);border-left:4px solid var(--quote-line);
  border-radius:10px;padding:10px 12px;margin:0 0 8px}
.quote p{margin:0;font-size:15.5px}
.lab{display:inline-block;font-weight:700;font-size:12.5px;color:var(--quote-lab);
  border:1px solid var(--quote-line);border-radius:5px;padding:0 7px;margin-right:8px;
  background:var(--card);vertical-align:1px}
.plain{background:var(--plain-bg);border:1px solid var(--plain-line);border-left:4px solid var(--plain-line);
  border-radius:10px;padding:10px 12px;margin:0}
.plain p{margin:0;font-size:15.5px;color:var(--ink2)}
.plain .lab{color:var(--plain-lab);border-color:var(--plain-line)}
.time{font-size:12.5px;color:var(--ink3);margin:6px 0 8px;font-variant-numeric:tabular-nums}
.note{font-size:13px;color:var(--ink3);margin-top:8px}

/* 括号导图 */
.outline{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);padding:14px 16px;font-size:14.5px;color:var(--ink2)}
.outline ul{margin:4px 0 0;padding-left:18px;list-style:none}
.outline>ul{padding-left:0}
.outline li{margin:5px 0;line-height:1.8}
.on{color:var(--accent);font-weight:700}
.osub{color:var(--ink);font-weight:600}
.omk{color:var(--ink3)}
footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);color:var(--ink3);font-size:12.5px}
@media print{body{background:#fff}.topic,.item,.kcard,.tablewrap{box-shadow:none;break-inside:avoid}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${esc(n.title || '视频笔记')}</h1>
  ${meta.length ? `<div class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div>` : ''}
</header>
${n.tldr ? `<div class="tldr"><b>一句话看懂　</b>${esc(n.tldr)}</div>` : ''}
${covLine.length ? `<div class="cov">${esc(covLine.join('　|　'))}</div>` : ''}
${(cov.missing && cov.missing.length) ? `<div class="warn">⚠️ 缺失说明：${esc(cov.missing.join('；'))}</div>` : ''}
${(n.ads && n.ads.length) ? `<div class="warn">已跳过广告时段：${esc(n.ads.map(a => a.t0 + '–' + a.t1).join('、'))}</div>` : ''}

<h2 class="sect">内容地图</h2>
<div class="hint">共 ${topics.length} 个主题 / ${totalItems} 条知识点，小标题列即各条要点速览</div>
<div class="tablewrap"><table class="map">
<thead><tr><th>#</th><th>主题</th><th>时间段</th><th>条数</th><th>小标题</th></tr></thead>
<tbody>
${mapRows}
</tbody></table></div>

<h2 class="sect">关键结论速览</h2>
<div class="hint">只列 ⭐ 核心结论，共 ${key.length} 条，按主题顺序，可先扫这一节抓主线</div>
<div class="keys">
${keyCards}
</div>

${topicHtml}

<h2 class="sect">思维导图大纲</h2>
<div class="hint">◆ 为全片根节点；括号内是记忆顺序编号：（1）主题 →（1.1）知识点，逐级展开，按顺序记忆</div>
<div class="outline"><ul>
<li><span class="on">◆</span>${esc(n.title || '视频笔记')}
${outlineHtml}
</ul></div>

<footer>
共 ${topics.length} 个主题 / ${totalItems} 条知识点${lite ? '（精简模式）' : ''}。素材来自视频，仅限个人学习，禁止商用。
</footer>
</div>
</body>
</html>`;
}

/* ---------------------------------------------------------------- 主流程 */
function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('缺少 notes.json 路径'); process.exit(1); }
  const lite = args.includes('--lite');
  const wantHtml = args.includes('--html');
  const outArg = args.find(a => a.startsWith('--out='));
  const notes = JSON.parse(fs.readFileSync(file, 'utf8'));

  // 结构体检：不合格直接报错，避免渲染出半成品
  const errs = [];
  if (!Array.isArray(notes.topics) || !notes.topics.length) errs.push('topics 为空');
  for (const t of notes.topics || []) {
    if (!t.title) errs.push('topic 缺 title');
    if (!Array.isArray(t.items)) errs.push('topic 缺 items');
    for (const it of t.items || []) {
      if (!it.text) errs.push('知识点缺原话');
      if (!it.plain) errs.push('知识点缺简易理解');
      if (!it.ts) errs.push('知识点缺时间戳');
      if (!clean(it.title)) errs.push('知识点缺小标题');
    }
  }
  if (errs.length) {
    console.log(JSON.stringify({ ok: false, errors: errs.slice(0, 8) }));
    process.exit(2);
  }

  const md = renderMd(notes, lite);
  const base = outArg ? outArg.slice(6) : path.join(path.dirname(file), lite ? 'notes_lite.md' : 'notes.md');
  fs.writeFileSync(base, md, 'utf8');

  let htmlOut = null;
  if (wantHtml) {
    htmlOut = base.replace(/\.md$/i, '') + '.html';
    fs.writeFileSync(htmlOut, renderHtml(notes, lite), 'utf8');
  }

  // 可选：RAG 入库元数据（用户明确要求时才需要）
  let ragOut = null;
  if (args.includes('--rag')) {
    const tags = new Set();
    for (const t of notes.topics || []) {
      clean(t.title).split(/[、，,：:（）()与和及/]/)
        .map(s => s.trim()).filter(s => s.length >= 2 && s.length <= 10)
        .forEach(s => tags.add(s));
    }
    const chunks = [];
    let k = 0;
    for (const t of notes.topics || []) {
      for (const it of t.items || []) {
        k++;
        chunks.push({
          id: `${notes.bvid || 'kb'}-${k}`,
          no: `${t.no || 0}.${k}`,
          title: itemTitle(it),
          topic: t.title, topic_range: t.range || '',
          topic_summary: t.summary || '',
          ts: it.ts || '', source: it.src || '',
          mark: normMark(it.mark), confidence: normConf(it.conf),
          text: it.text, plain: it.plain || '', conflict: !!it.conflict
        });
      }
    }
    const rag = {
      doc_type: 'video_knowledge_note',
      source: { platform: 'bilibili', bvid: notes.bvid || '', page: notes.page || 1, url: notes.url || '', title: notes.title, duration: notes.duration || '', up: notes.up || '' },
      tags: [...tags].slice(0, 12),
      coverage: notes.coverage || {},
      chunks
    };
    ragOut = path.join(path.dirname(file), 'rag.json');
    fs.writeFileSync(ragOut, JSON.stringify(rag, null, 1), 'utf8');
  }

  console.log(JSON.stringify({
    ok: true, out: base, html: htmlOut, chars: md.length,
    topics: notes.topics.length,
    items: notes.topics.reduce((a, t) => a + t.items.length, 0),
    mode: lite ? '精简' : '完整',
    rag: ragOut
  }));
}

main();
