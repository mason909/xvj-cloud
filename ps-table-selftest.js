// 一次性自检：把播放设置表里的纯函数从 public/index.html 抠出来跑断言（不起服务、不连库、不动数据）。
// 口径必须与服务端 playSettingsValue / normalizePlaySettings / findPlaySettingsError 对齐：
// 全默认的格子不落键、空表整个键都不下发，否则存量房间的 rev 会漂移一次、每台在线设备白重同步。
// 叠化（dissolve / dissolve_ms）已于 2026-11-12 随功能整条删除，这一格只剩 order。
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到 ' + name);
  const eol = src.indexOf('\n', i);
  if (src.slice(i, eol).trim().endsWith('}')) return src.slice(i, eol);
  const j = src.indexOf('\n}\n', i);
  if (j < 0) throw new Error('未找到 ' + name + ' 结尾');
  return src.slice(i, j + 2);
}
const names = ['_psCell', '_psTableOf', '_psSnap',
  '_psGroupHtml', '_psSetCell', '_psHdmiSw', '_psDraftOf', '_psTableHtml', 'psSet', 'psSetHdmi',
  // 切表时的「丢掉未保存草稿」闸门：确认框弹几次是这段的价值所在，所以连同墙板那半一起抠进来
  '_psDirty', '_confirmDropPsDraft', '_exitPsMode', '_wpDirty', '_wpHwSnap', '_wpCodeSnap', '_confirmDropWpDraft', '_exitWpMode', '_exitTableModes'];
const consts = src.match(/^var (PS_ORDERS|WP_SOURCES) = .*$/gm).join('\n');
const code = consts + '\n' + names.map(grab).join('\n');

const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escA = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// psSet / _psDraftOf 摸得到工作台状态与重绘，给它们一份最小替身（重绘只记次数，不碰 DOM）
const s = { rf: 'r1', _psMode: true, _psDraft: null, _wpMode: false, _wpDraft: null, rooms: [] };
let renders = 0;
// confirm 由页面全局函数变成注入替身：记下每句文案，答复由下面的开关决定
const asks = [];
let askAnswer = true;
const confirm = msg => { asks.push(String(msg)); return askAnswer; };
// 学习态（候选帧 + 倒计时）归墙板表自己管，这里只证明退出时把它叫醒了
let learns = 0;
const box = {};
new Function('exports', 'esc', 'escA', 's', '_loadRoomCfg', 'renderPsEditor', 'confirm', '_wpLearnReset',
  code + '\nObject.assign(exports,{' + names.join(',') + '});')(
  box, esc, escA, s,
  r => { const c = JSON.parse(r.config || '{}'); c.scenes = c.scenes || {}; ['A', 'B'].forEach(k => { c.scenes[k] = c.scenes[k] || {}; c.scenes[k].folder_mappings = c.scenes[k].folder_mappings || {}; }); return c; },
  () => { renders++; },
  confirm,
  () => { learns++; });
const T = box;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label + '\n      got  ' + g + '\n      want ' + w); }
};
const has = (label, html, needle) => eq(label, html.indexOf(needle) >= 0, true);

console.log('_psCell（全默认 → null = 不落键）:');
eq('顺序循环 → null', T._psCell({ order: 'seq' }), null);
eq('空对象 → null', T._psCell({}), null);
eq('随机 → 只带 order', T._psCell({ order: 'shuffle' }), { order: 'shuffle' });
eq('残留的 dissolve 键不再往下带', T._psCell({ dissolve: true, dissolve_ms: 800, order: 'shuffle' }), { order: 'shuffle' });
eq('只有残留 dissolve、顺序仍是默认 → 整格不落键', T._psCell({ dissolve: true, dissolve_ms: 800 }), null);
eq('脏 order 回落 seq（= 默认，不落键）', T._psCell({ order: 'random' }), null);
eq('非对象/数组/null 一律 null', [T._psCell('x'), T._psCell([1]), T._psCell(null), T._psCell(5)], [null, null, null, null]);
eq('点歌屏开（hdmi:true）落键', T._psCell({ hdmi: true }), { hdmi: true });
eq('点歌屏关（hdmi:false）= 默认，不落键', T._psCell({ hdmi: false }), null);
eq('两个键共存时都保留', T._psCell({ order: 'shuffle', hdmi: true }), { order: 'shuffle', hdmi: true });
eq('hdmi 脏值（非 true）当默认关', [T._psCell({ hdmi: 'yes' }), T._psCell({ hdmi: 1 })], [null, null]);

console.log('_psTableOf:');
eq('两幕各读各的表', T._psTableOf({ scenes: { A: { play_settings: { '01': { order: 'shuffle' } } }, B: { play_settings: { '02': { order: 'shuffle' } } } } }, 'A'),
  { '01': { order: 'shuffle' } });
eq('全默认的格子读进来就被丢掉', T._psTableOf({ scenes: { A: { play_settings: { '01': { order: 'seq' }, '02': { order: 'shuffle' } } } } }, 'A'),
  { '02': { order: 'shuffle' } });
eq('01~30 之外的键原样留着（整表 PUT 不能替别人清设置）', Object.keys(T._psTableOf({ scenes: { A: { play_settings: { '31': { order: 'shuffle' }, 'A01': { order: 'shuffle' } } } } }, 'A')), ['31', 'A01']);
eq('没配 → 空表', T._psTableOf({ scenes: { A: {} } }, 'A'), {});
eq('幕缺失/config 空/数组/字符串都不抛', [T._psTableOf({ scenes: {} }, 'B'), T._psTableOf({}, 'A'),
  T._psTableOf({ scenes: { A: { play_settings: ['x'] } } }, 'A'), T._psTableOf({ scenes: { A: { play_settings: 'x' } } }, 'A')], [{}, {}, {}, {}]);

console.log('_psSnap（判「有没有未保存改动」）:');
const d0 = { A: { '01': { order: 'shuffle' } }, B: {} };
eq('键序不同不算改动', T._psSnap({ A: { '02': { order: 'shuffle' }, '01': { order: 'shuffle' } }, B: {} })
  !== T._psSnap({ A: { '01': { order: 'shuffle' }, '02': { order: 'shuffle' } }, B: {} }), false);
eq('顺序变了算改动', T._psSnap({ A: { '01': { order: 'seq' } }, B: {} }) !== T._psSnap(d0), true);
eq('B 幕变了也算改动', T._psSnap({ A: d0.A, B: { '01': { order: 'shuffle' } } }) !== T._psSnap(d0), true);
eq('多带的脏键（如残留 dissolve）不算改动 —— 与服务端丢键同口径', T._psSnap({ A: { '01': { order: 'shuffle', dissolve: true } }, B: {} }), T._psSnap(d0));
eq('点歌屏拨了一下也算改动', T._psSnap({ A: { '01': { hdmi: true } }, B: {} }) !== T._psSnap({ A: {}, B: {} }), true);
eq('hdmi:false 读进草稿时按默认丢掉（快照里只剩真设置）', T._psTableOf({ scenes: { A: { play_settings: { '01': { hdmi: false } } } } }, 'A'), {});

console.log('_psGroupHtml（一幕一格两个 td）:');
const gOff = T._psGroupHtml('A', '01', null, 0, false);
eq('两个格子', (gOff.match(/<td/g) || []).length, 2);
has('没素材 → 破折号', gOff, '>—</td>');
has('默认选顺序循环', gOff, '<option value="seq" selected>顺序循环</option>');
has('只剩顺序一个回调', gOff, "psSet('A','01','order',this.value)");
eq('不再有叠化控件', /checkbox|dissolve/.test(gOff), false);
eq('A 组不画竖分隔', gOff.indexOf('ps-sep') >= 0, false);
const gOn = T._psGroupHtml('B', '07', { order: 'shuffle' }, 3, true);
has('B 组第一格画竖分隔', gOn, 'class="wp-cnt has ps-sep"');
has('有素材 → 绿色计数', gOn, '>3</td>');
has('随机循环选中', gOn, '<option value="shuffle" selected>随机循环</option>');
has('无障碍标签带幕与格', gOn, 'aria-label="第B幕 文件夹07 的播放顺序"');

console.log('psSet（草稿 mutation：回到全默认就删键）:');
function seed(psA, psB) {
  s.rooms = [{ id: 'r1', config: JSON.stringify({ scenes: { A: { play_settings: psA || {} }, B: { play_settings: psB || {} } } }) }];
  s._psDraft = null;
  renders = 0;
  return T._psDraftOf();
}
eq('草稿按房间建基线', (() => { const d = seed(); return [d.roomId, T._psSnap(d) === d.base, renders]; })(), ['r1', true, 0]);
eq('改成随机 → 落键', (() => { const d = seed(); T.psSet('A', '01', 'order', 'shuffle'); return [d.A, renders]; })(),
  [{ '01': { order: 'shuffle' } }, 1]);
eq('随机改回顺序 → 整格删键（库里原有这格，删掉当然算一次改动）', (() => { const d = seed({ '01': { order: 'shuffle' } }); T.psSet('A', '01', 'order', 'seq'); return [d.A, T._psSnap(d) === d.base]; })(),
  [{}, false]);
eq('本来没设 → 改了又改回去 → 回到基线（空表不落键，rev 不漂移）', (() => { const d = seed(); T.psSet('A', '01', 'order', 'shuffle'); T.psSet('A', '01', 'order', 'seq'); return [d.A, T._psSnap(d) === d.base]; })(),
  [{}, true]);
eq('脏 order 值归一成 seq（等同默认 → 删键）', (() => { const d = seed({ '01': { order: 'shuffle' } }); T.psSet('A', '01', 'order', 'random'); return d.A; })(), {});
eq('改一格不动别的格', (() => { const d = seed({ '01': { order: 'shuffle' }, '02': { order: 'shuffle' } }); T.psSet('A', '01', 'order', 'seq'); return d.A; })(),
  { '02': { order: 'shuffle' } });
eq('B 幕独立', (() => { const d = seed(); T.psSet('B', '03', 'order', 'shuffle'); return [d.A, d.B]; })(),
  [{}, { '03': { order: 'shuffle' } }]);
eq('脏幕/脏字段 → 不动草稿也不重绘', (() => { const d = seed(); T.psSet('C', '01', 'order', 'shuffle'); T.psSet('A', '01', 'dissolve', true); return [d.A, renders]; })(), [{}, 0]);

console.log('点歌屏开关（psSetHdmi：一行拨 A/B 两幕）:');
eq('拨开关不动这一格的播放顺序', (() => { const d = seed({ '01': { order: 'shuffle' } }); T.psSetHdmi('01', true); return d.A; })(),
  { '01': { order: 'shuffle', hdmi: true } });
eq('拨播放顺序不抹点歌屏开关', (() => { const d = seed({ '01': { hdmi: true } }); T.psSet('A', '01', 'order', 'shuffle'); return d.A; })(),
  { '01': { hdmi: true, order: 'shuffle' } });
eq('按行拨：A、B 两幕落同一个值', (() => { const d = seed({ '02': { order: 'shuffle' } }, { '02': { order: 'shuffle' } }); T.psSetHdmi('02', true); return [d.A, d.B]; })(),
  [{ '02': { order: 'shuffle', hdmi: true } }, { '02': { order: 'shuffle', hdmi: true } }]);
eq('开了再关 → 整格回到基线（hdmi 键删掉）', (() => { const d = seed(); T.psSetHdmi('01', true); T.psSetHdmi('01', false); return [d.A, d.B, T._psSnap(d) === d.base]; })(),
  [{}, {}, true]);
eq('只开了点歌屏 → 草稿算脏（这格要落键）', (() => { const d = seed(); T.psSetHdmi('01', true); return T._psSnap(d) !== d.base; })(), true);
eq('读库时全默认的格子不进草稿', (() => { const d = seed({ '01': { order: 'seq' }, '02': { order: 'shuffle' } }); return Object.keys(d.A); })(), ['02']);
console.log('_psTableHtml（整表结构：5 列 × 30 行，表头两层不能错位）:');
s.rf = 'r1';
s.rooms = [{ id: 'r1', config: JSON.stringify({ scenes: {
  A: { folder_mappings: { '01': ['a', 'b'], '03': ['c'] }, play_settings: { '01': { order: 'shuffle' }, '02': { hdmi: true } } },
  B: { folder_mappings: { '02': ['d'] }, play_settings: { '02': { order: 'shuffle', hdmi: true } } } } }) }];
s._psDraft = null;
const tbl = T._psTableHtml();
const trs = tbl.match(/<tr>[\s\S]*?<\/tr>/g) || [];
eq('表头 2 行 + 数据 30 行', trs.length, 32);
eq('第一层表头：文件夹/点歌屏两个 rowspan2 + 两组 colspan2', (trs[0].match(/rowspan="2"/g) || []).length + (trs[0].match(/colspan="2"/g) || []).length, 4);
has('表头有「点歌屏」', trs[0], '>点歌屏</th>');
eq('第二层表头 4 个 th（文件夹/点歌屏两格被 rowspan 占着）', (trs[1].match(/<th/g) || []).length, 4);
eq('每行 6 个 td', trs.slice(2).map(r => (r.match(/<td/g) || []).length), new Array(30).fill(6));
eq('每行 1 个控件 × 2 幕', trs.slice(2).map(r => (r.match(/onchange="psSet\('/g) || []).length), new Array(30).fill(2));
eq('每行 1 个点歌屏开关', trs.slice(2).map(r => (r.match(/onchange="psSetHdmi\(/g) || []).length), new Array(30).fill(1));
eq('没拨过的行点歌屏默认关（不带 checked）', trs[2].indexOf('name="psh-01" checked') < 0, true);
has('02 行 A/B 两幕都开着 → 这一行开关带 checked', trs[3], 'name="psh-02" checked');
has('开关列带竖分隔', trs[2], 'class="ps-sep">');
has('A 幕 01 随机循环选中', trs[2], "psSet('A','01','order',this.value)\"><option value=\"seq\">顺序循环</option><option value=\"shuffle\" selected>");
has('B 幕 02 随机循环选中', trs[3], '<option value="shuffle" selected>随机循环');
has('素材数按幕各算各的（A01=2，B01=—）', trs[2], 'class="wp-cnt has" title="第A幕 文件夹01 里有几个素材（0 个的话设了也没画面）">2</td>');
has('已设格数进工具条（A01/随机 + A02、B02/开点歌屏）', tbl, '已设 3 格');
has('硬切口径写在表前（免得有人以为还有叠化可开）', tbl, '素材轮播的交接一律硬切');
has('保存/重读两个入口', tbl, 'onclick="psSave()"');
has('全局复制入口（覆盖本店其余房间的播放设置）', tbl, 'onclick="psCopyAll()"');
has('重读入口', tbl, 'onclick="psReload()"');
eq('干净草稿不标未保存', tbl.indexOf('● 有未保存改动') >= 0, false);
T.psSet('A', '05', 'order', 'shuffle');
has('改一格就标未保存', T._psTableHtml(), '● 有未保存改动');
s.rooms = [];
s._psDraft = null;
has('房间还没加载完 → 给一句人话而不是半屏空表', T._psTableHtml(), '房间数据还没加载完');

eq('切房间后旧草稿不复用', (() => { seed(); s.rf = 'r2'; s.rooms = [{ id: 'r2', config: '{"scenes":{"A":{"play_settings":{"05":{"order":"shuffle"}}}}}' }]; return T._psDraftOf().A; })(),
  { '05': { order: 'shuffle' } });

console.log('_exitTableModes（切到另一张总表时的丢弃确认：每张脏表只问一句）:');
s.rf = 'r1';
const psDraft = dirty => { const d = { roomId: 'r1', A: {}, B: {} }; d.base = T._psSnap(d); if (dirty) d.A['01'] = { order: 'shuffle' }; return d; };
const wpDraft = dirty => {
  const d = { roomId: 'r1', enabled: true, path: '/dev/ttyS1', baud: 9600,
    dataBits: 8, parity: 'none', stopBits: 1, code: {} };
  d.baseHw = T._wpHwSnap(d); d.baseCode = T._wpCodeSnap(d);
  if (dirty) d.code['01'] = { panel: 'F50A00010300' }; return d;
};
const reset = (psDirty, wpDirty) => {
  s._psMode = true; s._wpMode = true;
  s._psDraft = psDraft(psDirty); s._wpDraft = wpDraft(wpDirty);
  asks.length = 0; askAnswer = true;
};
eq('两张表都干净 → 一句都不问', (() => { reset(false, false); return [T._exitTableModes(), asks.length]; })(), [true, 0]);
eq('只有播放表脏 → 问一句（曾经问两句：闸门和退出函数各弹一次）',
  (() => { reset(true, false); return [T._exitTableModes(), asks.length]; })(), [true, 1]);
eq('问过就清干净：模式、草稿和学习态一起走', (() => { reset(true, false); learns = 0; T._exitTableModes(); return [s._psMode, s._psDraft, s._wpMode, s._wpDraft, learns]; })(), [false, null, false, null, 1]);
eq('回答"留下" → 不动任何状态', (() => { reset(true, false); askAnswer = false; const d = s._psDraft; return [T._exitTableModes(), asks.length, s._psMode, s._psDraft === d]; })(), [false, 1, true, true]);
eq('只有墙板表脏 → 问的是墙板上那句',
  (() => { reset(false, true); const r = T._exitTableModes(); return [r, asks.length, /墙板串口/.test(asks[0])]; })(), [true, 1, true]);
eq('只改学习绑定也算墙板表脏（草稿闸门要盖住新加的那一格）', (() => {
  reset(false, false);
  s._wpDraft.code['01'] = { panel: 'F50A00010300' };
  const dirty = T._wpDirty();
  return [dirty, T._exitTableModes(), asks.length];
})(), [true, true, 1]);
eq('两张都脏 → 各问一句，不重复',
  (() => { reset(true, true); const r = T._exitTableModes(); return [r, asks.length, /播放设置表/.test(asks[1])]; })(), [true, 2, true]);
eq('前一张留下 → 后一张不再被打扰',
  (() => { reset(true, true); askAnswer = false; const r = T._exitTableModes(); return [r, asks.length, s._psMode, s._wpMode]; })(), [false, 1, true, true]);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);