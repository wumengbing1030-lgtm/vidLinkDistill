/* kb.js 离线自测：不联网、不依赖守护进程，验证清洗/融合/分段/预算逻辑 */
process.env.KB_UNIT = '1';
const K = require('./kb.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
};

/* 1. 碎片归并 */
console.log('[1] 字幕碎片 → 通顺句子');
{
  const cues = [];
  const words = ['盐对人', '体非常', '重要。', '如果长', '期缺盐', '就会没劲。'];
  words.forEach((w, i) => cues.push({ t: i * 3, e: i * 3 + 3, text: w }));
  const s = K.cuesToSentences(cues);
  ok('合并为 2 句', s.length === 2, s);
  ok('首句时间戳=0', s[0].t === 0, s[0]);
  ok('句末保留句号', /。$/.test(s[0].text), s[0].text);
}

/* 2. 清洗：口水词 + 广告 */
console.log('[2] 口水词 / 广告剔除');
{
  const raw = [
    { t: 0, e: 5, text: '那么其实这个盐是非常重要的一种矿物质' },
    { t: 6, e: 10, text: '记得点赞投币一键三连加关注公众号领取资料' },
    { t: 11, e: 15, text: '所以牛需要定期补充盐分否则会没力气' }
  ];
  const r = K.cleanSentences(raw);
  ok('广告句被剔除', r.sentences.length === 2, r.sentences.map(x => x.text));
  ok('句首口水词已削', r.sentences[0].text.startsWith('盐是'), r.sentences[0].text);
  ok('识别出广告时段', r.adSegments.length === 1, r.adSegments);
}

/* 3. 画面去噪 */
console.log('[3] 画面文字去噪');
{
  const blocks = [
    { t0: 0, t1: 10, lines: ['行者道荣bilibili', '00:35', '盐的摄入量', 'NaCl'] },
    { t0: 10, t1: 20, lines: ['行老道菜lib山', '2024'] }
  ];
  const c = K.sanitizeOcr(blocks, { owner: '' });
  ok('水印/时间码被过滤', c.length === 1 && c[0].lines.length === 2, c);
  ok('保留真实术语', c[0].lines.includes('盐的摄入量'), c[0].lines);
}

/* 4. 融合：烧录字幕校正 + 整块丢弃 + PPT 保留 */
console.log('[4] 音画融合');
{
  const frags = [{ t: 0, e: 6, text: '如果牛牛长时间铁不到盐就会捏不拉击的' }];
  const blocks = [
    { t0: 0, t1: 6, lines: ['如果牛牛长时间吃不到盐就会蔫不拉几的'] },   // 烧录字幕，且能纠正同音字
    { t0: 7, t1: 12, lines: ['盐分流失', '电解质平衡', '补水策略'] }      // PPT 内容，应保留
  ];
  const f = K.fuse(blocks, frags);
  ok('同音字被画面字幕校正', /吃不到盐/.test(frags[0].text), frags[0].text);
  ok('校正计数=1', f.fixed === 1, f.fixed);
  ok('烧录字幕块被丢弃', f.droppedBlocks === 1, f.droppedBlocks);
  ok('PPT 块被保留', f.blocks.length === 1 && f.blocks[0].lines.length === 3, f.blocks);
}

/* 5. 分段：40 分钟视频按话题/时长切分 */
console.log('[5] 长视频分段');
{
  const sentences = [];
  for (let i = 0; i < 600; i++) {
    const t = i * 4;
    const gap = (i === 200 || i === 420) ? 120 : 0;   // 两处长静默 → 应切段
    sentences.push({ t: t + gap, e: t + gap + 4, text: (i % 3 === 0 ? '这里指的是概念说明' : i % 3 === 1 ? '第一步先设置参数' : '注意这个风险边界') + i });
  }
  const secs = K.buildSections(sentences, []);
  ok('切出多段(>=4)', secs.length >= 4, secs.length);
  ok('每段不超过 5 分钟', secs.every(s => s.t1 - s.t0 <= 320), secs.map(s => s.t1 - s.t0));
  ok('时间戳单调递增', secs.every((s, i) => i === 0 || s.t0 > secs[i - 1].t0), secs.map(s => s.t0));
}

/* 6. 摘要包体积与模式 */
console.log('[6] 摘要包预算 / 模式');
{
  const sentences = [];
  for (let i = 0; i < 400; i++) sentences.push({ t: i * 4, e: i * 4 + 4, text: '这是第' + i + '句比较长的讲解内容，用来测试预算控制是否生效' });
  const secs = K.buildSections(sentences, []);
  const meta = { title: 'T', bvid: 'BVtest', aid: 1, pageNo: 1, pageCount: 1, duration: 1600, owner: 'X' };
  const ai = { source: 's', count: sentences.length, hasTs: true, adSegments: [] };
  const oi = { blocks: [], frames: 0 };
  const full = K.buildDigest(meta, ai, oi, secs, { budget: 6000, mode: 'full' });
  const small = K.buildDigest(meta, ai, oi, secs, { budget: 1200, mode: 'full' });
  const lite = K.buildDigest(meta, ai, oi, secs, { budget: 6000, mode: 'lite' });
  ok('完整模式不超预算', full.length <= 6400, full.length);
  ok('小预算触发截断说明', /已截断/.test(small), small.slice(-60));
  ok('精简模式更短', lite.length < full.length, [lite.length, full.length]);
}

/* 7. 交叉印证用完整短语 */
console.log('[7] 交叉印证');
{
  const sec = {
    idx: 1, t0: 0, t1: 60,
    items: [{ t: 0, e: 5, text: '所以盐分会随着汗液流失导致电解质平衡被打破', types: [], score: 3 }],
    ocr: [{ t0: 0, t1: 10, lines: ['电解质平衡', '脱水风险'] }]
  };
  const cx = K.crossCheck(sec);
  ok('命中完整术语', cx.includes('电解质平衡'), cx);
  ok('不出碎片(长度>=3)', cx.every(x => x.length >= 3), cx);
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
