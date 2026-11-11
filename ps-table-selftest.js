// 一次性自检：把播放设置表里的纯函数从 public/index.html 抠出来跑断言（不起服务、不连库、不动数据）。
// 口径必须与服务端 playSettingsValue / normalizePlaySettings / findPlaySettingsError 对齐：
// 全默认的格子不落键、空表整个键都不下发，否则存量房间的 rev 会漂移一次、每台在线设备白重同步。
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到 ' + name);
  const eol = src.indexOf('\n', i);
  if (src.slice(i, eol).trim().endsWith('}')) return src.slice(i, eol);
  const j = src.indexOf('\n}\n', i);
  if (j < 0) throw new Error('未找到 ' + name + ' 结尾');
  return src.slice(i, j + 2);
}
const names = ['_psMsOk', '_psMs', '_psCell', '_psTableOf', '_psSnap', '_psErrors',
  '_psGroupHtml', '_psDraftOf', '_psTableHtml', 'psSet',
  // 切表时的「丢掉未保存草稿」闸门：确认框弹几次是这段的价值所在，所以连同墙板那半一起抠进来
  '_psDirty', '_confirmDropPsDraft', '_exitPsMode', '_wpDirty', '_wpSnap', '_confirmDropWpDraft', '_exitWpMode', '_exitTableModes'];
const consts = src.match(/^var (PS_DISSOLVE_MS_MIN|PS_ORDERS) = .*$/gm).join('\n');
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
const box = {};
new Function('exports', 'esc', 'escA', 's', '_loadRoomCfg', 'renderPsEditor', 'confirm',
  code + '\nObject.assign(exports,{' + names.join(',') + '});')(
  box, esc, escA, s,
  r => { const c = JSON.parse(r.config || '{}'); c.scenes = c.scenes || {}; ['A', 'B'].forEach(k => { c.scenes[k] = c.scenes[k] || {}; c.scenes[k].folder_mappings = c.scenes[k].folder_mappings || {}; }); return c; },
  () => { renders++; },
  confirm);
const T = box;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label + '\n      got  ' + g + '\n      want ' + w); }
};
const has = (label, html, needle) => eq(label, html.indexOf(needle) >= 0, true);

console.log('_psMsOk / _psMs（与服务端 dissolveMsValue 同一把尺）:');
eq('边界 100 / 3000 在圈内', [T._psMsOk(100), T._psMsOk(3000)], [true, true]);
eq('越界/小数/字符串/脏类型都不算合法', [99, 3001, 2.5, '400', null, undefined, [400], true].map(T._psMsOk),
  [false, false, false, false, false, false, false, false]);
eq('读库时数字字符串认', T._psMs('600'), 600);
eq('读库时脏值回落默认档（不抛）', [T._psMs(5000), T._psMs(null), T._psMs(''), T._psMs([3]), T._psMs(undefined)], [400, 400, 400, 400, 400]);

console.log('_psCell（全默认 → null = 不落键）:');
eq('不叠化 + 顺序 → null', T._psCell({ dissolve: false, order: 'seq' }), null);
eq('空对象 → null', T._psCell({}), null);
eq('只开叠化 → 补默认时长与顺序', T._psCell({ dissolve: true }), { dissolve: true, order: 'seq', dissolve_ms: 400 });
eq('只改随机 → 不带时长键', T._psCell({ order: 'shuffle' }), { dissolve: false, order: 'shuffle' });
eq('叠化开着才带时长', T._psCell({ dissolve: true, dissolve_ms: 800, order: 'shuffle' }), { dissolve: true, order: 'shuffle', dissolve_ms: 800 });
eq('关着叠化时时长键被丢掉', T._psCell({ dissolve: false, dissolve_ms: 800, order: 'shuffle' }), { dissolve: false, order: 'shuffle' });
eq('严格 true 才算开（"true" 不算）', T._psCell({ dissolve: 'true' }), null);
eq('脏 order 回落 seq', T._psCell({ order: 'random' }), null);
eq('时长脏值回落默认档', T._psCell({ dissolve: true, dissolve_ms: 99999 }).dissolve_ms, 400);
eq('非对象/数组/null 一律 null', [T._psCell('x'), T._psCell([1]), T._psCell(null), T._psCell(5)], [null, null, null, null]);

console.log('_psTableOf:');
eq('两幕各读各的表', T._psTableOf({ scenes: { A: { play_settings: { '01': { dissolve: true } } }, B: { play_settings: { '02': { order: 'shuffle' } } } } }, 'A'),
  { '01': { dissolve: true, order: 'seq', dissolve_ms: 400 } });
eq('全默认的格子读进来就被丢掉', T._psTableOf({ scenes: { A: { play_settings: { '01': { dissolve: false, order: 'seq' }, '02': { dissolve: true } } } } }, 'A'),
  { '02': { dissolve: true, order: 'seq', dissolve_ms: 400 } });
eq('01~30 之外的键原样留着（整表 PUT 不能替别人清设置）', Object.keys(T._psTableOf({ scenes: { A: { play_settings: { '31': { order: 'shuffle' }, 'A01': { order: 'shuffle' } } } } }, 'A')), ['31', 'A01']);
eq('没配 → 空表', T._psTableOf({ scenes: { A: {} } }, 'A'), {});
eq('幕缺失/config 空/数组/字符串都不抛', [T._psTableOf({ scenes: {} }, 'B'), T._psTableOf({}, 'A'),
  T._psTableOf({ scenes: { A: { play_settings: ['x'] } } }, 'A'), T._psTableOf({ scenes: { A: { play_settings: 'x' } } }, 'A')], [{}, {}, {}, {}]);

console.log('_psSnap（判「有没有未保存改动」）:');
const d0 = { A: { '01': { dissolve: true, order: 'seq', dissolve_ms: 400 } }, B: {} };
eq('键序不同不算改动', T._psSnap({ A: { '02': { order: 'shuffle' }, '01': { dissolve: true, order: 'seq', dissolve_ms: 400 } }, B: {} })
  !== T._psSnap({ A: { '01': { dissolve: true, order: 'seq', dissolve_ms: 400 }, '02': { order: 'shuffle' } }, B: {} }), false);
eq('格内键序不同不算改动', T._psSnap({ A: { '01': { dissolve_ms: 400, order: 'seq', dissolve: true } }, B: {} }), T._psSnap(d0));
eq('时长变了算改动', T._psSnap({ A: { '01': { dissolve: true, order: 'seq', dissolve_ms: 600 } }, B: {} }) !== T._psSnap(d0), true);
eq('顺序变了算改动', T._psSnap({ A: { '01': { dissolve: true, order: 'shuffle', dissolve_ms: 400 } }, B: {} }) !== T._psSnap(d0), true);
eq('B 幕变了也算改动', T._psSnap({ A: d0.A, B: { '01': { order: 'shuffle' } } }) !== T._psSnap(d0), true);
eq('时长缺省与 null 视为同一状态（都表示"没填"）', T._psSnap({ A: { '01': { dissolve: true, order: 'seq' } }, B: {} })
  === T._psSnap({ A: { '01': { dissolve: true, order: 'seq', dissolve_ms: null } }, B: {} }), true);

console.log('_psErrors（保存前拦一道，别让 5000 静默变成 400）:');
eq('合法 → 无错', T._psErrors({ A: { '01': { dissolve: true, order: 'seq', dissolve_ms: 400 } }, B: {} }), []);
eq('越界/空/小数/字符串都报出来', T._psErrors({ A: {
  '01': { dissolve: true, dissolve_ms: 5000 }, '02': { dissolve: true, dissolve_ms: null },
  '03': { dissolve: true, dissolve_ms: 2.5 }, '04': { dissolve: true, dissolve_ms: '400' } }, B: {} }),
  ['第一幕 01 的叠化时长', '第一幕 02 的叠化时长', '第一幕 03 的叠化时长', '第一幕 04 的叠化时长']);
eq('关着叠化的格子不查时长', T._psErrors({ A: { '01': { dissolve: false, order: 'shuffle' } }, B: {} }), []);
eq('两幕都查，键排序稳定', T._psErrors({ A: { '09': { dissolve: true, dissolve_ms: 1 }, '02': { dissolve: true, dissolve_ms: 1 } }, B: { '01': { dissolve: true } } }),
  ['第一幕 02 的叠化时长', '第一幕 09 的叠化时长', '第二幕 01 的叠化时长']);
eq('空表 → 无错', T._psErrors({ A: {}, B: {} }), []);

console.log('_psGroupHtml（一幕一格四个 td）:');
const gOff = T._psGroupHtml('A', '01', null, 0, false);
eq('四个格子', (gOff.match(/<td/g) || []).length, 4);
has('没素材 → 破折号', gOff, '>—</td>');
has('关着时 checkbox 不勾', gOff, 'type="checkbox"');
eq('关着时不勾 checked', gOff.indexOf(' checked') >= 0, false);
has('关着时时长框禁用', gOff, ' disabled');
has('关着时不标红', gOff, 'class="ps-num"');
has('顺序默认选顺序循环', gOff, '<option value="seq" selected>顺序循环</option>');
has('回调带对幕/格/字段', gOff, "psSet('A','01','dissolve',this.checked)");
has('时长回调', gOff, "psSet('A','01','dissolve_ms',this.value)");
has('顺序回调', gOff, "psSet('A','01','order',this.value)");
eq('A 组不画竖分隔', gOff.indexOf('ps-sep') >= 0, false);
const gOn = T._psGroupHtml('B', '07', { dissolve: true, order: 'shuffle', dissolve_ms: 800 }, 3, true);
has('B 组第一格画竖分隔', gOn, 'class="wp-cnt has ps-sep"');
has('有素材 → 绿色计数', gOn, '>3</td>');
has('开着时勾上', gOn, ' checked');
eq('开着时时长框不禁用', gOn.indexOf(' disabled') >= 0, false);
has('时长回显', gOn, 'value="800"');
has('随机循环选中', gOn, '<option value="shuffle" selected>随机循环</option>');
has('时长上下界写进控件', gOn, 'min="100" max="3000"');
const gBad = T._psGroupHtml('A', '02', { dissolve: true, order: 'seq', dissolve_ms: 5000 }, 1, false);
has('填坏的时长标红', gBad, 'class="ps-num bad"');
has('坏值原样回显（不静默改成 400）', gBad, 'value="5000"');
has('空时长回显为空 + placeholder', T._psGroupHtml('A', '02', { dissolve: true, dissolve_ms: null }, 1, false), 'value="" placeholder="400"');
has('无障碍标签带幕与格', gOn, 'aria-label="第B幕 文件夹07 的叠化开关"');

console.log('psSet（草稿 mutation：回到全默认就删键）:');
function seed(psA, psB) {
  s.rooms = [{ id: 'r1', config: JSON.stringify({ scenes: { A: { play_settings: psA || {} }, B: { play_settings: psB || {} } } }) }];
  s._psDraft = null;
  renders = 0;
  return T._psDraftOf();
}
eq('草稿按房间建基线', (() => { const d = seed(); return [d.roomId, T._psSnap(d) === d.base, renders]; })(), ['r1', true, 0]);
eq('开叠化 → 落键并补默认时长', (() => { const d = seed(); T.psSet('A', '01', 'dissolve', true); return [d.A, renders]; })(),
  [{ '01': { dissolve: true, order: 'seq', dissolve_ms: 400 } }, 1]);
eq('改成随机（叠化仍关）→ 留键但不带时长', (() => { const d = seed(); T.psSet('A', '01', 'order', 'shuffle'); return d.A; })(),
  { '01': { dissolve: false, order: 'shuffle' } });
eq('随机 + 关叠化 → 删掉时长键', (() => { const d = seed({ '01': { dissolve: true, order: 'shuffle', dissolve_ms: 800 } }); T.psSet('A', '01', 'dissolve', false); return d.A; })(),
  { '01': { dissolve: false, order: 'shuffle' } });
eq('两项都回默认 → 整格删键（库里原有这格，删掉当然算一次改动）', (() => { const d = seed({ '01': { dissolve: true, order: 'seq', dissolve_ms: 400 } }); T.psSet('A', '01', 'dissolve', false); return [d.A, T._psSnap(d) === d.base]; })(),
  [{}, false]);
eq('本来没设 → 开了又关 → 回到基线（空表不落键，rev 不漂移）', (() => { const d = seed(); T.psSet('A', '01', 'dissolve', true); T.psSet('A', '01', 'dissolve', false); return [d.A, T._psSnap(d) === d.base]; })(),
  [{}, true]);
eq('随机也回顺序 → 整格删键', (() => { const d = seed({ '01': { order: 'shuffle' } }); T.psSet('A', '01', 'order', 'seq'); return d.A; })(), {});
eq('时长原样收下（越界也留着，交给 _psErrors 拦）', (() => { const d = seed(); T.psSet('A', '01', 'dissolve', true); T.psSet('A', '01', 'dissolve_ms', '5000'); return [d.A['01'].dissolve_ms, T._psErrors(d)]; })(),
  [5000, ['第一幕 01 的叠化时长']]);
eq('清空时长 → null（同样拦下）', (() => { const d = seed(); T.psSet('A', '01', 'dissolve', true); T.psSet('A', '01', 'dissolve_ms', '  '); return d.A['01'].dissolve_ms; })(), null);
eq('改时长不动别的格', (() => { const d = seed({ '01': { dissolve: true, dissolve_ms: 400 }, '02': { order: 'shuffle' } }); T.psSet('A', '01', 'dissolve_ms', 900); return [d.A['01'].dissolve_ms, d.A['02']]; })(),
  [900, { dissolve: false, order: 'shuffle' }]);
eq('B 幕独立', (() => { const d = seed(); T.psSet('B', '03', 'order', 'shuffle'); return [d.A, d.B]; })(),
  [{}, { '03': { dissolve: false, order: 'shuffle' } }]);
eq('脏幕/脏字段 → 不动草稿也不重绘', (() => { const d = seed(); T.psSet('C', '01', 'dissolve', true); T.psSet('A', '01', 'nope', 1); return [d.A, renders]; })(), [{}, 0]);
eq('读库时全默认的格子不进草稿', (() => { const d = seed({ '01': { dissolve: false, order: 'seq' }, '02': { dissolve: true } }); return Object.keys(d.A); })(), ['02']);
console.log('_psTableHtml（整表结构：9 列 × 30 行，表头两层不能错位）:');
s.rf = 'r1';
s.rooms = [{ id: 'r1', config: JSON.stringify({ scenes: {
  A: { folder_mappings: { '01': ['a', 'b'], '03': ['c'] }, play_settings: { '01': { dissolve: true, dissolve_ms: 600, order: 'shuffle' } } },
  B: { folder_mappings: { '02': ['d'] }, play_settings: { '02': { order: 'shuffle' } } } } }) }];
s._psDraft = null;
const tbl = T._psTableHtml();
const trs = tbl.match(/<tr>[\s\S]*?<\/tr>/g) || [];
eq('表头 2 行 + 数据 30 行', trs.length, 32);
eq('第一层表头：文件夹 rowspan2 + 两组 colspan4', (trs[0].match(/rowspan="2"/g) || []).length + (trs[0].match(/colspan="4"/g) || []).length, 3);
eq('第二层表头 8 个 th（文件夹那格被 rowspan 占着）', (trs[1].match(/<th/g) || []).length, 8);
eq('每行 9 个 td', trs.slice(2).map(r => (r.match(/<td/g) || []).length), new Array(30).fill(9));
eq('每行 3 个控件 × 2 幕', trs.slice(2).map(r => (r.match(/onchange="psSet/g) || []).length), new Array(30).fill(6));
has('A 幕 01 的叠化勾上、时长 600、随机选中', trs[2], 'value="600"');
has('A 幕 01 随机循环选中', trs[2], "psSet('A','01','order',this.value)\"><option value=\"seq\">顺序循环</option><option value=\"shuffle\" selected>");
has('B 幕 02 只改了顺序，时长框禁用', trs[3], ' disabled');
has('素材数按幕各算各的（A01=2，B01=—）', trs[2], 'class="wp-cnt has" title="第A幕 文件夹01 里有几个素材（0 个的话设了也没画面）">2</td>');
has('已设格数进工具条', tbl, '已设 2 格');
has('作用范围写在表前（免得有人以为切墙板也叠化）', tbl, '切墙板、切幕、试播接管都是硬切');
has('保存/重读两个入口', tbl, 'onclick="psSave()"');
has('重读入口', tbl, 'onclick="psReload()"');
eq('干净草稿不标未保存', tbl.indexOf('● 有未保存改动') >= 0, false);
T.psSet('A', '05', 'order', 'shuffle');
has('改一格就标未保存', T._psTableHtml(), '● 有未保存改动');
s.rooms = [];
s._psDraft = null;
has('房间还没加载完 → 给一句人话而不是半屏空表', T._psTableHtml(), '房间数据还没加载完');

eq('切房间后旧草稿不复用', (() => { seed(); s.rf = 'r2'; s.rooms = [{ id: 'r2', config: '{"scenes":{"A":{"play_settings":{"05":{"order":"shuffle"}}}}}' }]; return T._psDraftOf().A; })(),
  { '05': { dissolve: false, order: 'shuffle' } });

console.log('_exitTableModes（切到另一张总表时的丢弃确认：每张脏表只问一句）:');
s.rf = 'r1';
const psDraft = dirty => { const d = { roomId: 'r1', A: {}, B: {} }; d.base = T._psSnap(d); if (dirty) d.A['01'] = { dissolve: true, order: 'seq', dissolve_ms: 400 }; return d; };
const wpDraft = dirty => { const d = { roomId: 'r1', enabled: true, defaultNo: 1, path: '/dev/ttyS1', baud: 9600, A: {}, B: {} }; d.base = T._wpSnap(d); if (dirty) d.A['01'] = 5; return d; };
const reset = (psDirty, wpDirty) => {
  s._psMode = true; s._wpMode = true;
  s._psDraft = psDraft(psDirty); s._wpDraft = wpDraft(wpDirty);
  asks.length = 0; askAnswer = true;
};
eq('两张表都干净 → 一句都不问', (() => { reset(false, false); return [T._exitTableModes(), asks.length]; })(), [true, 0]);
eq('只有播放表脏 → 问一句（曾经问两句：闸门和退出函数各弹一次）',
  (() => { reset(true, false); return [T._exitTableModes(), asks.length]; })(), [true, 1]);
eq('问过就清干净：模式与草稿一起走', (() => { reset(true, false); T._exitTableModes(); return [s._psMode, s._psDraft, s._wpMode, s._wpDraft]; })(), [false, null, false, null]);
eq('回答"留下" → 不动任何状态', (() => { reset(true, false); askAnswer = false; const d = s._psDraft; return [T._exitTableModes(), asks.length, s._psMode, s._psDraft === d]; })(), [false, 1, true, true]);
eq('只有墙板表脏 → 问的是墙板上那句',
  (() => { reset(false, true); const r = T._exitTableModes(); return [r, asks.length, /墙板表/.test(asks[0])]; })(), [true, 1, true]);
eq('两张都脏 → 各问一句，不重复',
  (() => { reset(true, true); const r = T._exitTableModes(); return [r, asks.length, /播放设置表/.test(asks[1])]; })(), [true, 2, true]);
eq('前一张留下 → 后一张不再被打扰',
  (() => { reset(true, true); askAnswer = false; const r = T._exitTableModes(); return [r, asks.length, s._psMode, s._wpMode]; })(), [false, 1, true, true]);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);