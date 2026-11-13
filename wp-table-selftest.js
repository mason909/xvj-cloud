// 一次性自检：把墙板配置表里的纯函数从 public/index.html 抠出来跑断言（不起服务、不连库、不动数据）。
// 口径（2026-11-13）：没有编号、也不分幕，一张 { '01': {player,panel} } 的码值表（一格最多两路码：点歌机 + 墙板）+ 串口硬件参数。
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到 ' + name);
  // 单行写法（function _wpPath(v) { return ...; }）：找不到就会滑到下一个函数的右花括号，把别人的函数体一起抠进来
  const eol = src.indexOf('\n', i);
  if (src.slice(i, eol).trim().endsWith('}')) return src.slice(i, eol);
  const j = src.indexOf('\n}\n', i);
  if (j < 0) throw new Error('未找到 ' + name + ' 结尾');
  return src.slice(i, j + 2);
}
const names = ['_wpFrame', '_wpCell', '_wpSrc', '_wpSrcName', '_wpRule', '_wpRulesOf', '_wpCodeOf', '_wpBindFromCode',
  '_wpCodeSnap', '_wpCodeCount', '_wpHwSnap', '_wpDirty', '_wpBindErrors', '_wpCodeIntent',
  '_wpMergeFrames', '_wpFreshFrames', '_wpLearning', '_wpGateHint', '_wpCodeCellHtml',
  '_wpFieldsOf', '_wpPath', '_wpBaud', '_wpBit', '_wpParity', '_wpBaudOptions', '_wpOptNums', '_wpParityOptions'];
// 纯函数引用的模块级常量（串口节点形状/档位、帧闸、绑定上限、码值两列、格子数）
const consts = ['WP_SERIAL_BAUDS', 'WP_SERIAL_DEFAULT_PATH', 'WP_SERIAL_PATH_RE',
  'WP_SERIAL_DATA_BITS', 'WP_SERIAL_PARITIES', 'WP_SERIAL_STOP_BITS',
  'WP_FRAME_HEX_RE', 'WP_BINDINGS_MAX', 'WP_SOURCES', 'WP_FOLDER_COUNT'];
// 常量声明有跨行的（WP_SERIAL_PARITIES 是对象数组），也有行尾挂注释的（WP_FOLDER_COUNT）：
// 按行累加到某个以 ";"（可带行尾注释）收尾的行为止
function grabConst(name) {
  const i = src.indexOf('var ' + name + ' = ');
  if (i < 0) throw new Error('未找到常量 ' + name);
  const lines = src.slice(i).split('\n');
  let out = '';
  for (const l of lines) {
    out += l + '\n';
    if (/;\s*(\/\/.*)?$/.test(l)) return out.trimEnd();
  }
  throw new Error('未找到常量 ' + name + ' 结尾');
}
const code = consts.map(grabConst).join('\n')
  + '\n' + names.map(grab).join('\n');
const box = {};
const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escA = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// s 是页面的全局状态：_wpDirty / _wpFreshFrames / _wpCodeCellHtml 会读它，测试里按用例改
const s = {};
new Function('exports', 'esc', 'escA', 's', code + '\nObject.assign(exports,{' + names.join(',') + '});')(box, esc, escA, s);
const T = box;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label + '\n      got  ' + g + '\n      want ' + w); }
};
const has = (label, html, ...needles) => eq(label, needles.every(n => html.includes(n)), true);
const notHas = (label, html, needle) => eq(label, html.includes(needle), false);

console.log('_wpFrame（帧指纹，与服务端 WALLPANEL_FRAME_HEX_RE 同一把闸）:');
eq('大写化 + 去掉分组空格', [T._wpFrame('f5 05 01 21 03 00'), T._wpFrame(' F5 05\n')], ['F50501210300', 'F505']);
eq('最短 1 字节 / 最长 64 字节都在圈内', [T._wpFrame('D3').length, T._wpFrame('AA'.repeat(64))], [2, 'AA'.repeat(64)]);
eq('小麦那族的单字节功能码能录（D3 / B5，大小写与空格都归一）', [T._wpFrame('D3'), T._wpFrame(' b5 ')], ['D3', 'B5']);
eq('奇数长度/非十六进制/超长 = 不是帧',
  [T._wpFrame('F50A1'), T._wpFrame('GGGG'), T._wpFrame('AA'.repeat(65)), T._wpFrame('f5zz')],
  ['', '', '', '']);
eq('非字符串不当帧（数组的 toString 会漏进正则前面，先挡掉）',
  [T._wpFrame(''), T._wpFrame(null), T._wpFrame(undefined), T._wpFrame(7), T._wpFrame(['F505'])],
  ['', '', '', '', '']);

console.log('_wpCell（格子键 01~30，与服务端 PRESET_FOLDER_RE 同一把尺）:');
eq('两位数字串原样收下', [T._wpCell('01'), T._wpCell(' 07 '), T._wpCell('30')], ['01', '07', '30']);
eq('带幕前缀的旧写法折回裸格名', [T._wpCell('A01'), T._wpCell('B30')], ['01', '30']);
eq('31 越界、非两位、非字符串出局',
  [T._wpCell('31'), T._wpCell('1'), T._wpCell('00'), T._wpCell('A1'), T._wpCell('A31'), T._wpCell(7)],
  ['', '', '', '', '', '']);

console.log('_wpSrc / _wpSrcName（码值来源：点歌机 / 墙板）:');
eq('只认 player，其余一律归墙板列（存量绑定没这个键）',
  [T._wpSrc('player'), T._wpSrc('panel'), T._wpSrc(undefined), T._wpSrc('remote')], ['player', 'panel', 'panel', 'panel']);
eq('界面名就两种', [T._wpSrcName('player'), T._wpSrcName('panel')], ['点歌机码', '墙板码']);

console.log('_wpRule / _wpRulesOf（一条规则的干净形状：帧 + 格 + 来源）:');
eq('大写帧 + 裸格名，来源缺省归墙板', T._wpRule({ frame: 'f505', folder: 'A12' }), { frame: 'F505', folder: '12', source: 'panel' });
eq('点歌机码原样收下', T._wpRule({ frame: 'D3', folder: '01', source: 'player' }), { frame: 'D3', folder: '01', source: 'player' });
eq('存量 type/no 键不再带出去', T._wpRule({ frame: 'F505', folder: '03', type: 'panel_no', no: 7 }),
  { frame: 'F505', folder: '03', source: 'panel' });
eq('脏帧 / 脏格名 / 非对象 = null 丢掉',
  [T._wpRule({ frame: 'F50', folder: '05' }), T._wpRule({ frame: 'F505', folder: '31' }),
   T._wpRule({ frame: 'F505' }), T._wpRule(null), T._wpRule('x')],
  [null, null, null, null, null]);
eq('表内脏的当场丢 + 同帧先到先得',
  T._wpRulesOf([{ frame: 'F505', folder: '05' }, { frame: 'F505', folder: '07' }, { frame: 'BAD', folder: '06' }]),
  [{ frame: 'F505', folder: '05', source: 'panel' }]);
eq('同一格同一列两条帧（旧数据）→ 也是先到先得',
  T._wpRulesOf([{ frame: 'F505', folder: '05' }, { frame: 'AA55', folder: '05' }]),
  [{ frame: 'F505', folder: '05', source: 'panel' }]);
eq('同一格两路各一个码 → 都留着（点歌机 + 墙板）',
  T._wpRulesOf([{ frame: 'F505', folder: '05' }, { frame: 'D3', folder: '05', source: 'player' }]),
  [{ frame: 'F505', folder: '05', source: 'panel' }, { frame: 'D3', folder: '05', source: 'player' }]);
eq('同一列重复先到先得', T._wpRulesOf([{ frame: 'AA55', folder: '05', source: 'player' }, { frame: 'BB66', folder: '05', source: 'player' }]),
  [{ frame: 'AA55', folder: '05', source: 'player' }]);
eq('rules 不是数组 → 空表', [T._wpRulesOf(undefined).length, T._wpRulesOf('x').length, T._wpRulesOf({}).length], [0, 0, 0]);

console.log('_wpCodeOf（落库绑定表 → 界面码值表）:');
eq('一格两列各归各位，同列先到先得，幕前缀折回裸格名',
  T._wpCodeOf({ wallpanel_bindings: [{ frame: 'F505', folder: '01' }, { frame: 'AA55', folder: '01' },
    { frame: 'D3', folder: '01', source: 'player' }, { frame: 'BB66', folder: '02', source: 'player' }, { frame: 'CC77', folder: 'A05' }] }),
  { '01': { panel: 'F505', player: 'D3' }, '02': { player: 'BB66' }, '05': { panel: 'CC77' } });
eq('没配 / 脏值 / 旧的分幕形状都不抛（旧形状不再认）',
  [T._wpCodeOf({}), T._wpCodeOf(null), T._wpCodeOf({ wallpanel_bindings: 'x' }),
   T._wpCodeOf({ wallpanel_bindings: { A: [{ frame: 'F505', folder: '01' }] } })],
  [{}, {}, {}, {}]);

console.log('_wpBindFromCode（界面码值表 → 落库形状）:');
eq('按帧排序、两列各一条、脏码值丢掉',
  T._wpBindFromCode({ code: { '07': { panel: 'aa55' }, '01': { player: 'f505', panel: 'd3' }, '02': { panel: '' }, '03': { player: 'zz' } } }),
  [{ frame: 'AA55', folder: '07', source: 'panel' }, { frame: 'D3', folder: '01', source: 'panel' },
   { frame: 'F505', folder: '01', source: 'player' }]);
eq('空表 → 空数组', [T._wpBindFromCode({ code: {} }), T._wpBindFromCode({})], [[], []]);
eq('已录条数按格计数（一格两码算两个）',
  [T._wpCodeCount({ '01': { player: 'D3', panel: 'B5' }, '02': { panel: 'F505' }, '03': {} }),
   T._wpCodeCount(null)], [3, 0]);

console.log('_wpCodeSnap / _wpHwSnap / _wpDirty:');
const draft = (extra) => Object.assign({
  roomId: 'r1', enabled: false, path: '/dev/ttyUSB0', baud: null,
  dataBits: 8, parity: 'none', stopBits: 1, code: {}
}, extra || {});
eq('码值表键序不同不算改动',
  T._wpCodeSnap({ code: { '02': { panel: 'BB' }, '01': { panel: 'AA' } } }) === T._wpCodeSnap({ code: { '01': { panel: 'AA' }, '02': { panel: 'BB' } } }),
  true);
eq('同一格换到另一列算改动',
  T._wpCodeSnap({ code: { '01': { panel: 'AA' } } }) === T._wpCodeSnap({ code: { '01': { player: 'AA' } } }), false);
eq('码值变了算改动', T._wpCodeSnap({ code: { '01': { panel: 'AA' } } }) === T._wpCodeSnap({ code: { '01': { panel: 'AB' } } }), false);
eq('硬件六项都进基线', [
  T._wpHwSnap(draft({ baud: 9600 })) === T._wpHwSnap(draft({ baud: null })),
  T._wpHwSnap(draft({ dataBits: 7 })) === T._wpHwSnap(draft({ dataBits: 8 })),
  T._wpHwSnap(draft({ parity: 'odd' })) === T._wpHwSnap(draft({ parity: 'none' })),
  T._wpHwSnap(draft({ stopBits: 2 })) === T._wpHwSnap(draft({ stopBits: 1 })),
  T._wpHwSnap(draft({ path: '/dev/ttyS1' })) === T._wpHwSnap(draft({ path: '/dev/ttyUSB0' })),
  T._wpHwSnap(draft({ enabled: true })) === T._wpHwSnap(draft({ enabled: false }))
], [false, false, false, false, false, false]);
(() => {
  const d = draft();
  d.baseHw = T._wpHwSnap(d);
  d.baseCode = T._wpCodeSnap(d);
  s._wpMode = true; s.rf = 'r1'; s._wpDraft = d;
  const clean = T._wpDirty();
  d.code['01'] = { panel: 'F505' };
  const codeDirty = T._wpDirty();
  d.code = {};
  d.baud = 9600;
  const hwDirty = T._wpDirty();
  s.rf = 'r2';
  const otherRoom = T._wpDirty();
  s._wpMode = false; s._wpDraft = null; s.rf = '';
  eq('干净/改码值/改硬件/换房间的判定', [clean, codeDirty, hwDirty, otherRoom], [false, true, true, false]);
})();

console.log('_wpBindErrors（64 条上限，与服务端同一道闸）:');
(() => {
  const mk = n => { const o = {}; for (let i = 1; i <= n; i++) o[String(i).padStart(2, '0')] = { panel: 'AA' + String(i).padStart(4, '0') }; return o; };
  const over = T._wpBindErrors({ code: mk(65) });
  eq('65 条出一条，64 条不吭声', [over.length, over[0], T._wpBindErrors({ code: mk(64) }).length],
    [1, '录了 65 个码，超过上限 64 个', 0]);
  eq('一格两码按两条算', T._wpBindErrors({ code: { '01': { player: 'D3', panel: 'B5' } } }).length, 0);
  eq('没草稿也不抛', T._wpBindErrors(null).length, 0);
})();

console.log('_wpMergeFrames（多台机的候选帧并一份）:');
eq('同 hex 合计数、age 取最近那次',
  T._wpMergeFrames([{ frames: [{ hex: 'F505', n: 2, age: 3000 }, { hex: 'C501', n: 1, age: 500 }] },
                   { frames: [{ hex: 'f505', n: 3, age: 1000 }] }]),
  [{ hex: 'C501', n: 1, age: 500 }, { hex: 'F505', n: 5, age: 1000 }]);
eq('脏项与非帧 hex 丢掉，不抛', T._wpMergeFrames([{ frames: [null, 'x', { hex: 'BAD' }, { hex: 'F505' }] }]),
  [{ hex: 'F505', n: 1, age: 0 }]);
eq('n/age 缺失按 1 次、刚收到算', T._wpMergeFrames([{ frames: [{ hex: 'F505' }] }]), [{ hex: 'F505', n: 1, age: 0 }]);
eq('同 age 按 hex 字典序（轮询时列表不跳）',
  T._wpMergeFrames([{ frames: [{ hex: 'FFFF', n: 1, age: 0 }, { hex: '00AA', n: 1, age: 0 }] }]),
  [{ hex: '00AA', n: 1, age: 0 }, { hex: 'FFFF', n: 1, age: 0 }]);
eq('没有设备 / 没上报 → 空表', [T._wpMergeFrames(undefined).length, T._wpMergeFrames([{}]).length], [0, 0]);

console.log('_wpFreshFrames（开窗后新出现的帧才算候选）:');
eq('基线里已有的帧被滤掉，大小写统一后再比',
  (() => { s._wpBaseline = { 'F505': 1 }; const r = T._wpFreshFrames([{ frames: [{ hex: 'f505', n: 2, age: 900 }, { hex: 'AA55', n: 1, age: 5 }] }]); s._wpBaseline = null; return r; })(),
  [{ hex: 'AA55', n: 1, age: 5 }]);
eq('没有基线 → 全收', T._wpFreshFrames([{ frames: [{ hex: 'F505', n: 1, age: 0 }] }]).length, 1);

console.log('_wpFieldsOf（保存与全局复制共用的落库字段口径）:');
eq('七个键、总闸严格布尔、码值表归一成平铺数组（带来源）',
  T._wpFieldsOf({ enabled: 'true', path: '/dev/ttyS1', baud: 9600, dataBits: 8, parity: 'none', stopBits: 1,
    code: { '03': { panel: 'f50521' }, '01': { player: 'd3', panel: 'b5' } } }),
  { wallpanel_enabled: false, wallpanel_serial_path: '/dev/ttyS1', wallpanel_baud: 9600, wallpanel_data_bits: 8,
    wallpanel_parity: 'none', wallpanel_stop_bits: 1,
    wallpanel_bindings: [{ frame: 'B5', folder: '01', source: 'panel' }, { frame: 'D3', folder: '01', source: 'player' },
      { frame: 'F50521', folder: '03', source: 'panel' }] });
eq('开闸 + 空表也能原样给出', T._wpFieldsOf({ enabled: true, path: '/dev/ttyUSB0', baud: null, dataBits: 5, parity: 'even', stopBits: 2, code: {} }),
  { wallpanel_enabled: true, wallpanel_serial_path: '/dev/ttyUSB0', wallpanel_baud: null, wallpanel_data_bits: 5,
    wallpanel_parity: 'even', wallpanel_stop_bits: 2, wallpanel_bindings: [] });

console.log('_wpGateHint（总闸关着时的提示，常驻警告与学习空帧共用）:');
eq('开闸 = 空串', T._wpGateHint({ enabled: true }), '');
eq('关闸给一句能直接上屏的话', T._wpGateHint({ enabled: false }),
  '串口总闸关着：设备不会打开 485 串口，按墙板不会有反应，学习也收不到帧');
eq('只有严格 true 才算开（与 roomWallpanelFields 同尺）', [T._wpGateHint({ enabled: 'true' }), T._wpGateHint(null), T._wpGateHint(undefined)].every(Boolean), true);

console.log('_wpCodeCellHtml（一格的某一列码值框，可手输也可点开学习）:');
(() => {
  s._wpLearnMode = false; s._wpLearnCell = null; s._wpLearnUntil = 0;
  const withCode = T._wpCodeCellHtml('01', 'panel', { code: { '01': { player: 'D3', panel: 'F50501' } } });
  has('已录码：显示这一列的值 + 清空键可见', withCode, 'value="F50501"', 'wp-code bound', 'wp-code-x', '已录 F50501', 'data-src="panel"');
  notHas('有码时清空键不该藏起来', withCode, 'display:none');
  const player = T._wpCodeCellHtml('01', 'player', { code: { '01': { player: 'D3', panel: 'F50501' } } });
  has('同一格另一列显示自己的码', player, 'value="D3"', 'data-src="player"', '文件夹01 的点歌机码');
  const empty = T._wpCodeCellHtml('02', 'player', { code: {} });
  has('空格：可编辑 + 提示点此录码', empty, 'value=""', 'placeholder="点此录码"', '直接敲十六进制录码');
  has('空格：清空键在场但藏着（手输后不用重画就能露出来）', empty, 'wp-code-x', 'display:none');
  has('框上挂着直接编辑与学习的入口（带列名）', empty,
    'data-fid="02"', 'data-src="player"', 'onchange="wpSetCode(\'02\', \'player\', this.value, this)"',
    'onkeydown="wpCodeKey(event, \'02\', \'player\')"', 'onclick="wpLearnCell(\'02\', \'player\')"');
  notHas('不再只读', empty, 'readonly');
  s._wpLearnMode = true;
  const ready = T._wpCodeCellHtml('02', 'panel', { code: {} });
  has('学习开关已开：提示也可以直接敲，或点一下再按键', ready, '直接敲十六进制录码；或点一下再按墙板对应的那颗键');
  has('点歌机列的学习提示指向点歌机', T._wpCodeCellHtml('02', 'player', { code: {} }), '或点一下再按点歌机对应的那颗键');
  s._wpLearnCell = { fid: '02', src: 'player' };
  s._wpLearnUntil = Date.now() + 10000;
  const waiting = T._wpCodeCellHtml('02', 'player', { code: {} });
  has('等按键：那一列变 learning，占位提示等按键', waiting, 'placeholder="等按键…"', 'wp-code learning', 'display:none');
  has('等按键时也说明键盘可以接管', waiting, '敲键盘就是手输');
  const otherCol = T._wpCodeCellHtml('02', 'panel', { code: {} });
  notHas('同一格的另一列不在等', otherCol, '等按键…');
  const other = T._wpCodeCellHtml('03', 'player', { code: {} });
  notHas('同一时间只有那一格在等', other, '等按键…');
  s._wpLearnMode = false; s._wpLearnCell = null; s._wpLearnUntil = 0;
})();

console.log('_wpCodeIntent（手输值该做什么，清空=删、脏=不落库、同值=不动）:');
eq('空值：原本没码就不动，原本有码就清掉',
  [T._wpCodeIntent('', ''), T._wpCodeIntent('   ', 'F50501')],
  [{ kind: 'none' }, { kind: 'clear' }]);
eq('脏值不落库（奇数长度/非十六进制/超长）',
  ['F50A1', 'GGGG', 'F5'.repeat(65)].map(v => T._wpCodeIntent(v, 'F50501').kind), ['bad', 'bad', 'bad']);
eq('单字节码（小麦那族）是合法输入，归一成大写落库',
  [T._wpCodeIntent('d3', 'F50501'), T._wpCodeIntent(' b5 ', '')],
  [{ kind: 'set', hex: 'D3' }, { kind: 'set', hex: 'B5' }]);
eq('同一码换个大小写/加空格 = 不动，不白写一次库',
  [T._wpCodeIntent('f50501', 'F50501'), T._wpCodeIntent(' F5 05 01 ', 'F50501')],
  [{ kind: 'none' }, { kind: 'none' }]);
eq('合法新值：归一成大写再落', T._wpCodeIntent('f5 05 01 21 03 00', ''),
  { kind: 'set', hex: 'F50501210300' });
eq('非字符串当空（input 永远给字符串，这里只兜底不抛）',
  [T._wpCodeIntent(null, '').kind, T._wpCodeIntent(undefined, 'F505').kind, T._wpCodeIntent(7, '').kind],
  ['none', 'clear', 'none']);

console.log('_wpPath / _wpBaud（串口节点的显示值口径，与服务端 isSafeSerialPath 同一把尺）:');
eq('合法节点原样收下', [T._wpPath('/dev/ttyS1'), T._wpPath('/dev/ttyHSL0'), T._wpPath('/dev/ttyUSB0')],
  ['/dev/ttyS1', '/dev/ttyHSL0', '/dev/ttyUSB0']);
eq('脏形状回落默认节点', [T._wpPath('ttyUSB0'), T._wpPath('/dev/tty USB0'), T._wpPath('/dev/../../etc/passwd'),
  T._wpPath(''), T._wpPath(null), T._wpPath(undefined), T._wpPath(9)],
  ['/dev/ttyUSB0', '/dev/ttyUSB0', '/dev/ttyUSB0', '/dev/ttyUSB0', '/dev/ttyUSB0', '/dev/ttyUSB0', '/dev/ttyUSB0']);
eq('超长节点名回落默认（服务端同样 400）', T._wpPath('/dev/' + 'x'.repeat(65)), '/dev/ttyUSB0');
eq('档内整数收下（数字与数字字符串都要认）', [T._wpBaud(9600), T._wpBaud('115200'), T._wpBaud(1200)], [9600, 115200, 1200]);
eq('档外/脏类型 = null = 不改波特率', [T._wpBaud(12345), T._wpBaud('9600x'), T._wpBaud(0), T._wpBaud(''),
  T._wpBaud(null), T._wpBaud(undefined), T._wpBaud(true), T._wpBaud([9600])],
  [null, null, null, null, null, null, null, null]);

console.log('_wpBit / _wpParity（串口字符格式档位，与服务端 wallpanelBitChoice / parity 闸同尺）:');
eq('档内数据位收下（数字与数字字符串都要认）',
  [T._wpBit(8, [5, 6, 7, 8], 8), T._wpBit('7', [5, 6, 7, 8], 8), T._wpBit(5, [5, 6, 7, 8], 8)], [8, 7, 5]);
eq('档外/脏类型回落默认（不是 null：字符格式必须落一个真值给 stty）',
  [T._wpBit(4, [5, 6, 7, 8], 8), T._wpBit(9, [5, 6, 7, 8], 8), T._wpBit('x', [5, 6, 7, 8], 8),
   T._wpBit(null, [5, 6, 7, 8], 8), T._wpBit(undefined, [5, 6, 7, 8], 8), T._wpBit(1.5, [5, 6, 7, 8], 8)],
  [8, 8, 8, 8, 8, 8]);
eq('停止位档外回落 1', [T._wpBit(2, [1, 2], 1), T._wpBit(3, [1, 2], 1)], [2, 1]);
eq('校验位只收三个字面量，大小写与空格都过份',
  [T._wpParity('ODD'), T._wpParity(' even '), T._wpParity('none')], ['odd', 'even', 'none']);
eq('mark/space/脏类型回落 none', [T._wpParity('mark'), T._wpParity(''), T._wpParity(null), T._wpParity(7)], ['none', 'none', 'none', 'none']);

console.log('选项渲染:');
has('波特率：没设=驱动默认排第一（首项即选中）', T._wpBaudOptions(null), '<option value="">驱动默认</option>', '>9600</option>');
notHas('波特率：没设时不该有别的档位被选中', T._wpBaudOptions(null), ' selected');
has('波特率：设了就选中那一档', T._wpBaudOptions(19200), '<option value="19200" selected>19200</option>');
has('数据位档位按当前值选中', T._wpOptNums([5, 6, 7, 8], 7), '<option value="7" selected>7</option>');
has('校验位说人话（奇/偶/无）', T._wpParityOptions('odd'), '<option value="odd" selected>奇</option>', '>偶</option>');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
