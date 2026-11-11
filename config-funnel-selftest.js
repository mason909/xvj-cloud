// 一次性自检：把 server.js 里的纯函数漏斗抠出来跑断言（不连库、不起服务）。用完即删。
const fs = require('fs');
const crypto = require('crypto');
const src = fs.readFileSync(process.argv[2] || 'server.js', 'utf8');

function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到函数 ' + name);
  const j = src.indexOf('\n}\n', i);
  if (j < 0) throw new Error('未找到函数结尾 ' + name);
  return src.slice(i, j + 2);
}
const names = ['prefixedFolderKey', 'panelCellKey', 'normalizeMaterialIds', 'isSceneKey', 'isPlainObject',
  'normalizeFolderMappings', 'panelNoValue', 'normalizePanelNos', 'findPanelNoConflict', 'findPanelCellConflict',
  'dissolveMsValue', 'playSettingsValue', 'normalizePlaySettings', 'findPlaySettingsError',
  'mergeSceneConfig', 'prepareRoomConfig',
  'buildPrefixedScenes', 'mergePrefixedMappings',
  'roomSceneDigest', 'isSafeDeviceId', 'parseRoomConfig', 'isSafeFolderName', 'isSafeSerialPath',
  'roomDebugFlag', 'roomWallpanelFields', 'roomWallpanelDigest', 'findWallpanelFieldError', 'resolvePreviewTarget',
  'rememberDevicePanelNo', 'devicePanelNo'];
// 模块级常量（编号区间、波特率档、默认节点、播放设置取值域）：抠出来的函数直接引用它们，不带上就 ReferenceError
const consts = src.match(/^const (PANEL_NO_MIN|WALLPANEL_BAUDS|WALLPANEL_DEFAULT_PATH|DEVICE_PANEL_NO_TTL|PLAY_ORDERS|PLAY_DISSOLVE_MS_MIN).*$/gm).join('\n')
  // 【S-06i】心跳编号缓存是一张模块级 Map，测试要能往里塞/改时间戳，所以连它一起导出
  + '\n' + src.match(/^const devicePanelNoAt = .*$/m)[0];
const code = consts + '\n' + names.map(grab).join('\n');
const sandbox = {};
new Function('exports', 'crypto', code + '\nObject.assign(exports, {' + names.join(',') + ',devicePanelNoAt:devicePanelNoAt,DEVICE_PANEL_NO_TTL:DEVICE_PANEL_NO_TTL});')(sandbox, crypto);
const T = sandbox;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      got  ' + g + '\n      want ' + w); }
}

console.log('normalizeMaterialIds:');
eq('数组去重去空', T.normalizeMaterialIds(['a', 'a', '', 5, null, 'b']), ['a', 'b']);
eq('裸字符串按单个 id 收下', T.normalizeMaterialIds('pm_x'), ['pm_x']);
eq('数字 → 空', T.normalizeMaterialIds(5), []);
eq('null → 空', T.normalizeMaterialIds(null), []);

console.log('normalizeFolderMappings:');
eq('非法文件夹键丢弃 + 空数组丢弃', T.normalizeFolderMappings({ '01': ['m1'], '02': [], '../x': ['m2'], 'A01': ['m3'] }), { '01': ['m1'], 'A01': ['m3'] });
eq('非对象入参 → 空', T.normalizeFolderMappings('abc'), {});
eq('数组入参 → 空', T.normalizeFolderMappings(['a']), {});

console.log('buildPrefixedScenes:');
eq('只取 A/B + 前缀 + 排序', T.buildPrefixedScenes({ B: { name: '二', folder_mappings: { '01': ['b'] } }, A: { name: '一', folder_mappings: { '02': ['a2'], '01': ['a1'] } }, Z: { name: '脏' } }),
  { A: { name: '一', folder_mappings: { A01: ['a1'], A02: ['a2'] }, windows: [] }, B: { name: '二', folder_mappings: { B01: ['b'] }, windows: [] } });
eq('已带前缀不二次加', T.buildPrefixedScenes({ A: { folder_mappings: { A01: ['x'] } } }).A.folder_mappings, { A01: ['x'] });
const polluted = T.buildPrefixedScenes(JSON.parse('{"A":{"folder_mappings":{"01":"pm_a"}},"__proto__":{"windows":[{"id":"EVIL"}]}}'));
eq('返回值不再挂原型', Object.keys(polluted), ['A']);
eq('__proto__ 脏键不污染 Object.prototype', {}.windows, undefined);
eq('映射值是字符串时不炸成字符数组', T.buildPrefixedScenes({ A: { folder_mappings: { '01': 'ab' } } }).A.folder_mappings, { A01: ['ab'] });
eq('windows 非数组 → []', T.buildPrefixedScenes({ A: { windows: 'x' } }).A.windows, []);
eq('panel_no 加幕前缀 + 排序，设备按同一把键查', T.buildPrefixedScenes({ A: { panel_no: { '02': 7, '01': 3 } } }).A.panel_no, { A01: 3, A02: 7 });
eq('空/缺失 panel_no 不落键', Object.keys(T.buildPrefixedScenes({ A: { folder_mappings: {}, panel_no: {} }, B: { panel_no: { '01': 1 } } }).A), ['name', 'folder_mappings', 'windows']);
eq('脏编号下发前被丢掉', T.buildPrefixedScenes({ A: { panel_no: { '01': 3, '02': 99 } } }).A.panel_no, { A01: 3 });
eq('play_settings 加幕前缀 + 排序，设备按物理目录 id 查', T.buildPrefixedScenes({ A: { play_settings: { '02': { order: 'shuffle' }, '01': { dissolve: true, dissolve_ms: 600 } } } }).A.play_settings,
  { A01: { dissolve: true, order: 'seq', dissolve_ms: 600 }, A02: { dissolve: false, order: 'shuffle' } });
eq('空/全默认 play_settings 不落键', Object.keys(T.buildPrefixedScenes({ A: { play_settings: { '01': { dissolve: false, order: 'seq' } } }, B: { play_settings: {} } }).A), ['name', 'folder_mappings', 'windows']);
eq('A/B 各存各的（两幕是两套物理目录）', (() => {
  const p = T.buildPrefixedScenes({ A: { play_settings: { '01': { dissolve: true } } }, B: { play_settings: { '01': { order: 'shuffle' } } } });
  return [p.A.play_settings, p.B.play_settings];
})(), [{ A01: { dissolve: true, order: 'seq', dissolve_ms: 400 } }, { B01: { dissolve: false, order: 'shuffle' } }]);

console.log('roomWallpanelFields / roomWallpanelDigest:');
eq('缺省 → false + null + 默认节点 + 驱动波特率', T.roomWallpanelFields({}),
  { wallpanel_enabled: false, wallpanel_default_no: null, wallpanel_serial_path: '/dev/ttyUSB0', wallpanel_baud: null });
eq('非严格 true 不算开', T.roomWallpanelFields({ wallpanel_enabled: 'true' }),
  { wallpanel_enabled: false, wallpanel_default_no: null, wallpanel_serial_path: '/dev/ttyUSB0', wallpanel_baud: null });
eq('字符串数字默认编号收下', T.roomWallpanelFields({ wallpanel_enabled: true, wallpanel_default_no: '9' }).wallpanel_default_no, 9);
eq('越界/脏类型默认编号 → null', T.roomWallpanelFields({ wallpanel_default_no: 33 }).wallpanel_default_no, null);
eq('数组值不被 Number() 蒙混', T.roomWallpanelFields({ wallpanel_default_no: [3] }).wallpanel_default_no, null);
eq('合法节点 + 档内波特率原样落形状', T.roomWallpanelFields({ wallpanel_serial_path: '/dev/ttyS1', wallpanel_baud: '115200' }).wallpanel_serial_path, '/dev/ttyS1');
eq('非法节点回落默认（不跟着下发脏路径）', T.roomWallpanelFields({ wallpanel_serial_path: '/dev/../etc/passwd' }).wallpanel_serial_path, '/dev/ttyUSB0');
eq('不在档内的波特率 → null=驱动默认', T.roomWallpanelFields({ wallpanel_baud: 12345 }).wallpanel_baud, null);
eq('debug 变了才算 debug 变', T.roomWallpanelDigest({ debug: true }) === T.roomWallpanelDigest({}), true);
eq('开关变了才算墙板变', T.roomWallpanelDigest({ wallpanel_enabled: true }) !== T.roomWallpanelDigest({}), true);
eq('换串口节点/波特率也算墙板变（走 set_wallpanel，不进 rev）',
  [T.roomWallpanelDigest({ wallpanel_serial_path: '/dev/ttyS0' }) !== T.roomWallpanelDigest({}),
   T.roomWallpanelDigest({ wallpanel_baud: 9600 }) !== T.roomWallpanelDigest({})], [true, true]);
eq('回落值不产生假变更（新旧两侧同一函数）',
  T.roomWallpanelDigest({ wallpanel_serial_path: '../x' }) === T.roomWallpanelDigest({}), true);

console.log('findWallpanelFieldError（写入侧，非法值不许静默回落）:');
eq('没带 → null', T.findWallpanelFieldError({}), null);
eq('空串 → null（就是"用默认"）', T.findWallpanelFieldError({ wallpanel_serial_path: '', wallpanel_baud: '' }), null);
eq('合法形状 → null', T.findWallpanelFieldError({ wallpanel_serial_path: '/dev/ttyUSB1', wallpanel_baud: 9600 }), null);
eq('数字型 baud 字符串认', T.findWallpanelFieldError({ wallpanel_baud: '19200' }), null);
eq('越界 baud 报出可选档', T.findWallpanelFieldError({ wallpanel_baud: 12345 }),
  '波特率只能是 1200 / 2400 / 4800 / 9600 / 19200 / 38400 / 57600 / 115200 之一，留空则用驱动默认');
eq('非 /dev/ 路径报错', T.findWallpanelFieldError({ wallpanel_serial_path: 'ttyUSB0' }).slice(0, 4), '串口节点');
eq('对象型 baud 不当数字蒙混', T.findWallpanelFieldError({ wallpanel_baud: { v: 9600 } }) !== null, true);

console.log('mergePrefixedMappings:');
eq('同前缀键合并去重（A 里写了 B01 时与 B 的 B01 并起来）',
  T.mergePrefixedMappings({ A: { folder_mappings: { A01: ['x', 'y'], B01: ['shared'] } }, B: { folder_mappings: { B01: ['shared', 'z'] } } }),
  { A01: ['x', 'y'], B01: ['shared', 'z'] });
eq('脏值不抛', T.mergePrefixedMappings({ A: { folder_mappings: { A01: 5 } }, B: { folder_mappings: { B01: 'str' } } }), { A01: [], B01: ['str'] });
eq('入参为 undefined 不抛', T.mergePrefixedMappings(undefined), {});

console.log('normalizePanelNos:');
eq('只留合法键 + 1~32 整数', T.normalizePanelNos({ '01': 3, '02': '7', '../x': 5, 'A01': 9 }), { '01': 3, '02': 7, 'A01': 9 });
eq('幕内键归一成格名（A01 → 01）', T.normalizePanelNos({ 'A01': 9, '02': 7 }, 'A'), { '01': 9, '02': 7 });
eq('别的幕里 A01 是它自己的键，不动', T.normalizePanelNos({ 'A01': 9 }, 'B'), { 'A01': 9 });
eq('同格两个编号 → 先到先得，与入参键顺序无关', T.normalizePanelNos({ '01': 3, 'A01': 4 }, 'A'), { '01': 3 });
eq('越界/小数/脏类型/数组值丢弃', T.normalizePanelNos({ '01': 0, '02': 33, '03': 2.5, '04': null, '05': [3], '06': true, '07': '' }), {});
eq('非对象入参 → 空', T.normalizePanelNos('abc'), {});

console.log('findPanelCellConflict:');
eq('一格一编号 → null', T.findPanelCellConflict('A', { '01': 3, '02': 2 }), null);
eq('同一编号写两遍（01 与 A01）不算歧义', T.findPanelCellConflict('A', { '01': 3, 'A01': 3 }), null);
eq('同一格两个编号 → 报出两个键', T.findPanelCellConflict('A', { '01': 3, 'A01': 4 }), '场景A的 01 和 A01 是同一个文件夹，却分别绑了 3 号和 4 号，只留一个');
eq('脏键与会被丢弃的值不参与判定', T.findPanelCellConflict('A', { '../x': 1, 'A01': 99, '01': 2 }), null);
eq('非对象 → null', T.findPanelCellConflict('A', undefined), null);

console.log('findPanelNoConflict:');
eq('无重复 → null', T.findPanelNoConflict('A', { '01': 1, '02': 2 }), null);
eq('同幕重复 → 报出两个文件夹', T.findPanelNoConflict('A', { '01': 3, '02': 3 }), '场景A的墙板编号 3 同时绑在文件夹 01 和 02 上，一键只能对一个文件夹');
eq('空表 → null', T.findPanelNoConflict('A', undefined), null);

console.log('playSettingsValue / normalizePlaySettings（文件夹级播放设置）:');
eq('全默认 → null（这一格不落键）', T.playSettingsValue({ dissolve: false, order: 'seq' }), null);
eq('缺字段也算全默认', T.playSettingsValue({}), null);
eq('非严格 true 不算开叠化', T.playSettingsValue({ dissolve: 'true', order: 'seq' }), null);
eq('开叠化 → 带默认时长', T.playSettingsValue({ dissolve: true }), { dissolve: true, order: 'seq', dissolve_ms: 400 });
eq('只改随机顺序也保留（叠化关着）', T.playSettingsValue({ order: 'shuffle' }), { dissolve: false, order: 'shuffle' });
eq('叠化关着时时长不落键（否则关回去 rev 也回不到原值）', T.playSettingsValue({ dissolve: false, dissolve_ms: 900 }), null);
eq('时长数字字符串收下', T.playSettingsValue({ dissolve: true, dissolve_ms: '800' }).dissolve_ms, 800);
eq('越界时长回落默认（下发侧是总函数，写入侧另有 400）', T.playSettingsValue({ dissolve: true, dissolve_ms: 99 }).dissolve_ms, 400);
eq('脏 order 回落顺序', T.playSettingsValue({ dissolve: true, order: 'random' }).order, 'seq');
eq('非对象格 → null', [T.playSettingsValue(true), T.playSettingsValue(null), T.playSettingsValue('x')], [null, null, null]);
eq('键排序 + 幕内键归一 + 全默认格丢掉', T.normalizePlaySettings({ '02': { order: 'shuffle' }, '01': { dissolve: false }, 'A03': { dissolve: true, dissolve_ms: 600 }, '../x': { dissolve: true } }, 'A'),
  { '02': { dissolve: false, order: 'shuffle' }, '03': { dissolve: true, order: 'seq', dissolve_ms: 600 } });
eq('别的幕里 A03 是它自己的键，不动', T.normalizePlaySettings({ 'A03': { order: 'shuffle' } }, 'B'), { 'A03': { dissolve: false, order: 'shuffle' } });
eq('同格两种写法先到先得，与入参键顺序无关', T.normalizePlaySettings({ '01': { order: 'shuffle' }, 'A01': { dissolve: true } }, 'A'), { '01': { dissolve: false, order: 'shuffle' } });
eq('非对象入参 → 空表', [T.normalizePlaySettings('abc'), T.normalizePlaySettings(null), T.normalizePlaySettings([1])], [{}, {}, {}]);

console.log('findPlaySettingsError（写入侧，非法值不许静默回落）:');
eq('没带 → null', T.findPlaySettingsError({}), null);
eq('合法两幕 → null', T.findPlaySettingsError({ scenes: { A: { play_settings: { '01': { dissolve: true, dissolve_ms: 400, order: 'shuffle' } } }, B: { play_settings: { '02': { order: 'seq' } } } } }), null);
eq('空串/没带不算错', T.findPlaySettingsError({ scenes: { A: { play_settings: { '01': { dissolve_ms: '', order: '' } } } } }), null);
eq('脏 order 报出可选值', T.findPlaySettingsError({ scenes: { A: { play_settings: { '01': { order: 'random' } } } } }),
  '场景A 文件夹01 的播放顺序只能是 seq（顺序循环）或 shuffle（随机循环）');
eq('越界时长报错', T.findPlaySettingsError({ scenes: { B: { play_settings: { '07': { dissolve_ms: 5000 } } } } }),
  '场景B 文件夹07 的叠化时长只能是 100~3000 之间的整数毫秒');
eq('小数时长报错', T.findPlaySettingsError({ scenes: { A: { play_settings: { '01': { dissolve_ms: 400.5 } } } } }) !== null, true);
eq('对象型时长不当数字蒙混', T.findPlaySettingsError({ scenes: { A: { play_settings: { '01': { dissolve_ms: { v: 400 } } } } } }) !== null, true);
eq('带前缀的键在文案里折回格名', T.findPlaySettingsError({ scenes: { A: { play_settings: { 'A01': { order: 'x' } } } } }).indexOf('文件夹01') > 0, true);
eq('脏形状格不报（由规范化丢弃，与 folder_mappings 同口径）', T.findPlaySettingsError({ scenes: { A: { play_settings: { '01': true } } } }), null);

console.log('mergeSceneConfig:');
const ex = { name: '第一幕', folder_mappings: { '01': ['keep'] }, panel_no: { '01': 5 }, play_settings: {}, windows: [{ id: 'w1', name: 'W1' }], master: { brightness: 0.4 } };
eq('未带 scenes → 全继承 DB', T.mergeSceneConfig(undefined, ex, '第一幕'), ex);
eq('显式 {} 清空映射', T.mergeSceneConfig({ folder_mappings: {} }, ex, '第一幕').folder_mappings, {});
eq('显式 null 清空映射', T.mergeSceneConfig({ folder_mappings: null }, ex, '第一幕').folder_mappings, {});
eq('没带 panel_no → 继承 DB 的绑定', T.mergeSceneConfig({ folder_mappings: {} }, ex, '第一幕').panel_no, { '01': 5 });
eq('显式 panel_no:{} 解绑（不能被 DB 旧值继承回来）', T.mergeSceneConfig({ panel_no: {} }, ex, '第一幕').panel_no, {});
eq('继承来的脏编号也重新规范化', T.mergeSceneConfig({}, { panel_no: { '01': 99, '02': 4 } }, '第一幕').panel_no, { '02': 4 });
eq('带 sceneKey 时继承的带前缀键也归一', T.mergeSceneConfig({}, { panel_no: { 'A01': 4 } }, '第一幕', 'A').panel_no, { '01': 4 });
eq('没带 play_settings → 继承 DB 的设置', T.mergeSceneConfig({ folder_mappings: {} }, { play_settings: { '01': { dissolve: true, dissolve_ms: 600 } } }, '第一幕', 'A').play_settings,
  { '01': { dissolve: true, order: 'seq', dissolve_ms: 600 } });
eq('显式 play_settings:{} 关回默认（不能被 DB 旧值继承回来）', T.mergeSceneConfig({ play_settings: {} }, { play_settings: { '01': { order: 'shuffle' } } }, '第一幕', 'A').play_settings, {});
eq('把叠化关掉 = 那一格整个消失', T.mergeSceneConfig({ play_settings: { '01': { dissolve: false, order: 'seq' } } }, { play_settings: { '01': { dissolve: true } } }, '第一幕', 'A').play_settings, {});
eq('空 windows 数组不覆盖（清空走 PUT /windows）', T.mergeSceneConfig({ windows: [] }, ex, '第一幕').windows, ex.windows);
eq('非空 windows 覆盖', T.mergeSceneConfig({ windows: [{ id: 'n', name: 'N' }] }, ex, '第一幕').windows, [{ id: 'n', name: 'N' }]);
eq('master clamp 上界', T.mergeSceneConfig({ master: { brightness: 3 } }, ex, '第一幕').master, { brightness: 1 });
eq('master 非数字 → 0', T.mergeSceneConfig({ master: { brightness: 'hi' } }, ex, '第一幕').master, { brightness: 0 });
eq('incoming 是字符串也不抛', T.mergeSceneConfig('x', ex, '第一幕'), ex);

console.log('prepareRoomConfig（PUT /rooms 与 POST /rooms 共用的写库入口）:');
eq('坏 JSON → 400 文案', T.prepareRoomConfig('{oops').error, 'config 不是合法 JSON 字符串');
eq('数组 config → 400', T.prepareRoomConfig([1, 2]).error, 'config 必须是对象');
eq('scenes 不是对象 → 400', T.prepareRoomConfig({ scenes: 'x' }).error, 'config.scenes 必须是对象');
eq('scenes 里的脏键过滤，不污染原型', (() => {
  const p = T.prepareRoomConfig(JSON.parse('{"scenes":{"__proto__":{"windows":[{"id":"E"}]},"A":{}}}'), null);
  return [Object.keys(p.cfg.scenes), {}.windows];
})(), [['A', 'B'], undefined]);
eq('新建也拦同幕重复绑定', T.prepareRoomConfig({ scenes: { A: { panel_no: { '01': 3, '02': 3 } } } }, null).error,
  '场景A的墙板编号 3 同时绑在文件夹 01 和 02 上，一键只能对一个文件夹');
eq('新建也拦同一格两个编号', T.prepareRoomConfig({ scenes: { A: { panel_no: { '01': 3, 'A01': 4 } } } }, null).error,
  '场景A的 01 和 A01 是同一个文件夹，却分别绑了 3 号和 4 号，只留一个');
eq('字符串编号落库存成整数', T.prepareRoomConfig({ scenes: { A: { panel_no: { '07': '12' } } } }, null).cfg.scenes.A.panel_no, { '07': 12 });
eq('带前缀的键归一后入库（下发不再撞键）', T.prepareRoomConfig({ scenes: { A: { panel_no: { 'A01': 5 } } } }, null).cfg.scenes.A.panel_no, { '01': 5 });
eq('硬件字段按下发口径落库（"true"/99 不是开/有效默认号）', (() => {
  const c = T.prepareRoomConfig({ wallpanel_enabled: 'true', wallpanel_default_no: 99 }, null).cfg;
  return [c.wallpanel_enabled, c.wallpanel_default_no];
})(), [false, null]);
eq('非法串口节点写库被拦（不静默回落成默认口）', T.prepareRoomConfig({ wallpanel_serial_path: '/dev/tty USB0' }, null).error,
  '串口节点只能是 /dev/ 下的设备名（字母、数字、-、_），例如 /dev/ttyUSB0');
eq('非法波特率写库被拦', T.prepareRoomConfig({ wallpanel_baud: 10000 }, null).error !== null, true);
eq('新房间出生即带齐四个墙板字段（前端读库不再遇到 undefined 形状）', (() => {
  const c = T.prepareRoomConfig({}, null).cfg;
  return Object.keys(c).filter(k => k.indexOf('wallpanel') === 0).sort();
})(), ['wallpanel_baud', 'wallpanel_default_no', 'wallpanel_enabled', 'wallpanel_serial_path']);
eq('脏绑定不会锁死这间房：出生时归一，后续 PUT 继承的是干净表', (() => {
  const born = T.prepareRoomConfig({ scenes: { A: { panel_no: { '01': 3, 'A01': 3 } } } }, null).cfg;
  return T.prepareRoomConfig({ scenes: { A: { folder_mappings: {} } } }, born).cfg.scenes.A.panel_no;
})(), { '01': 3 });
eq('顶层键不丢（少带 debug 会被收敛点判成关了调试）', T.prepareRoomConfig({}, { debug: true, scenes: {} }).cfg.debug, true);
eq('播放设置非法时长写库被拦', T.prepareRoomConfig({ scenes: { A: { play_settings: { '01': { dissolve: true, dissolve_ms: 99 } } } } }, null).error,
  '场景A 文件夹01 的叠化时长只能是 100~3000 之间的整数毫秒');
eq('播放设置非法顺序写库被拦', T.prepareRoomConfig({ scenes: { B: { play_settings: { '02': { order: 'loop' } } } } }, null).error,
  '场景B 文件夹02 的播放顺序只能是 seq（顺序循环）或 shuffle（随机循环）');
eq('播放设置出生即归一（带前缀键折回格名、默认格丢掉）', T.prepareRoomConfig({ scenes: { A: { play_settings: { 'A01': { dissolve: true, dissolve_ms: 600 }, '02': { dissolve: false } } } } }, null).cfg.scenes.A.play_settings,
  { '01': { dissolve: true, order: 'seq', dissolve_ms: 600 } });
eq('少带 play_settings 的那一幕从 DB 继承（整份 PUT 不该抹掉另一幕）', (() => {
  const db = { scenes: { A: { play_settings: { '01': { order: 'shuffle' } } }, B: { play_settings: { '02': { dissolve: true } } } } };
  const c = T.prepareRoomConfig({ scenes: { A: { name: '第一幕' } } }, db).cfg;
  return [c.scenes.A.play_settings, c.scenes.B.play_settings];
})(), [{ '01': { dissolve: false, order: 'shuffle' } }, { '02': { dissolve: true, order: 'seq', dissolve_ms: 400 } }]);
eq('不带 scenes 时两幕全从 DB 继承', (() => {
  const dbCfg = { scenes: { A: { name: '第一幕', folder_mappings: { '01': ['m'] }, panel_no: { '01': 2 }, windows: [{ id: 'w', name: 'W' }], master: { brightness: 1 } } } };
  const c = T.prepareRoomConfig({ wallpanel_enabled: true }, dbCfg).cfg;
  return [c.scenes.A.folder_mappings, c.scenes.A.panel_no, c.scenes.A.windows.length, c.wallpanel_enabled];
})(), [{ '01': ['m'] }, { '01': 2 }, 1, true]);

console.log('roomSceneDigest:');
const r1 = T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [] } } });
eq('与脏键无关', T.roomSceneDigest(JSON.parse('{"scenes":{"A":{"folder_mappings":{"01":["x"]},"windows":[]},"__proto__":{"windows":[1]}}}')), r1);
eq('稳定（重复调用一致）', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [] } } }), r1);
eq('内容不同则 rev 不同', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['y'] }, windows: [] } } }) !== r1, true);
eq('config 为 null 不抛', typeof T.roomSceneDigest(null), 'string');
// 部署不抖 rev：mergeSceneConfig 之后每幕都带一个 panel_no:{}，若它跟着进指纹，
// 上线那一刻全库 rev 变化 → 每台在线设备被对账判成落后、各补发一次素材同步
eq('空 panel_no 不改 rev', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [], panel_no: {} } } }), r1);
eq('绑定编号会改 rev', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [], panel_no: { '01': 3 } } } }) !== r1, true);
eq('解绑回空后 rev 回到原值', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [], panel_no: null } } }), r1);
// 同一条理由适用于新增的 play_settings：上线那一刻全库每幕都会多一个 play_settings:{}（mergeSceneConfig 的确定形状），
// 它若跟着进指纹，每台在线设备都被对账判成落后、各补发一次同步、视频从头播
eq('空 play_settings 不改 rev', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [], play_settings: {} } } }), r1);
eq('全默认的格子不改 rev', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [], play_settings: { '01': { dissolve: false, order: 'seq', dissolve_ms: 900 } } } } }), r1);
eq('开叠化会改 rev', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [], play_settings: { '01': { dissolve: true } } } } }) !== r1, true);
eq('改随机顺序会改 rev', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [], play_settings: { '01': { order: 'shuffle' } } } } }) !== r1, true);
eq('关回默认后 rev 回到原值', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [], play_settings: { '01': { dissolve: false, order: 'seq' } } } } }), r1);
eq('键顺序不影响 rev', T.roomSceneDigest({ scenes: { A: { play_settings: { '02': { order: 'shuffle' }, '01': { dissolve: true } } } } }),
  T.roomSceneDigest({ scenes: { A: { play_settings: { '01': { dissolve: true }, '02': { order: 'shuffle' } } } } }));

console.log('parseRoomConfig:');
eq('合法字符串', T.parseRoomConfig('{"debug":true}'), { debug: true });
eq('已是对象', T.parseRoomConfig({ a: 1 }), { a: 1 });
eq('坏 JSON → {}', T.parseRoomConfig('{oops'), {});
eq('数组 → {}', T.parseRoomConfig('[1,2]'), {});
eq('数字 → {}', T.parseRoomConfig(42), {});
eq('JSON 数字 → {}', T.parseRoomConfig('42'), {});
eq('null → {}', T.parseRoomConfig(null), {});

console.log('isSafeDeviceId / isSceneKey:');
eq('正常 64 位 hex', T.isSafeDeviceId('a'.repeat(64)), true);
eq('通配符 %', T.isSafeDeviceId('%'), false);
eq('含斜杠', T.isSafeDeviceId('a/b'), false);
eq('空', T.isSafeDeviceId(''), false);
eq('A/B 合法', [T.isSceneKey('A'), T.isSceneKey('B')], [true, true]);
eq('__proto__/z/constructor 非法', ['__proto__', 'z', 'constructor'].map(T.isSceneKey), [false, false, false]);

console.log('resolvePreviewTarget（含墙板跟随窗）:');
const pvCfg = function (winsA, winsB) {
  return { scenes: { A: { folder_mappings: { '01': ['a1'], '03': ['a3'] }, windows: winsA },
                    B: { folder_mappings: { '02': ['b2'] }, windows: winsB || [] } } };
};
const fixed = { id: 'w_fix', name: '固定03', enabled: true, zIndex: 2, content: { type: 'SCENE_A', folderId: '03' } };
const fol = { id: 'w_fol', name: '跟随主屏', enabled: true, zIndex: 9, content: { type: 'SCENE_A', folderId: '01', follow: true } };
eq('固定窗按 folderId 命中', T.resolvePreviewTarget(pvCfg([fixed]), 'A', '03').winId, 'w_fix');
eq('跟随窗对任何本格素材都算候选（云端看不到设备当前编号）',
  T.resolvePreviewTarget(pvCfg([fol]), 'A', '07').winId, 'w_fol');
eq('跟随窗与固定窗同时命中 → 取 zIndex 最大的（屏上真看得见的那扇）',
  T.resolvePreviewTarget(pvCfg([fixed, fol]), 'A', '03').winId, 'w_fol');
eq('enabled:false 的跟随窗不当候选', T.resolvePreviewTarget(pvCfg([{ id: 'x', name: 'x', enabled: false, zIndex: 9, content: { type: 'SCENE_A', follow: true } }]), 'A', '03'), null);
eq('HDMI/color 窗不受 follow 影响（非本幕 SCENE 直接排除）',
  T.resolvePreviewTarget(pvCfg([{ id: 'h', name: 'h', enabled: true, zIndex: 9, content: { type: 'HDMI', follow: true } }]), 'A', '03'), null);
eq('follow 脏值（字符串 "true"）不算跟随',
  T.resolvePreviewTarget(pvCfg([{ id: 's', name: 's', enabled: true, zIndex: 9, content: { type: 'SCENE_A', folderId: '03', follow: 'yes' } }]), 'A', '07'), null);
eq('B 幕的跟随窗不抢 A 幕', T.resolvePreviewTarget(pvCfg([fixed], [{ id: 'wb', name: 'B跟随', enabled: true, zIndex: 5, content: { type: 'SCENE_B', follow: true } }]), 'A', '03').winId, 'w_fix');
eq('B 幕试播命中 B 的跟随窗', T.resolvePreviewTarget(pvCfg([fixed], [{ id: 'wb', name: 'B跟随', enabled: true, zIndex: 5, content: { type: 'SCENE_B', follow: true } }]), 'B', '07').winId, 'wb');

console.log('【S-06i】心跳里的当前墙板编号缓存（无 DDL，只活在内存）:');
const DEV = 'dev_panel_test';
const peek = function () { return T.devicePanelNo(DEV); };
T.devicePanelNoAt.clear();
T.rememberDevicePanelNo(DEV, 7, true);
eq('在线 + 合法编号 → 读得到', peek(), 7);
T.rememberDevicePanelNo(DEV, '12', true);
eq('数字字符串同样收下', peek(), 12);
T.rememberDevicePanelNo(DEV, 33, true);
eq('越界编号当"没带" → 直接清掉显示', peek(), null);
T.rememberDevicePanelNo(DEV, 5, true);
T.rememberDevicePanelNo(DEV, null, true);
eq('这一跳没带 panel_no = 设备说"现在没号"，不是保持原样', peek(), null);
T.rememberDevicePanelNo(DEV, 5, true);
T.rememberDevicePanelNo(DEV, 5, false);
eq('离线 → 立即清掉（别让列表挂着几分钟前的号）', peek(), null);
eq('没写过的设备 → null（读侧不会替别人编一个号）', T.devicePanelNo('dev_never'), null);
T.rememberDevicePanelNo('dev_other', 3, true);
T.devicePanelNoAt.delete(DEV);
eq('删某一台不动其它台（键是设备 id，不是房间 id）', T.devicePanelNo('dev_other'), 3);
T.rememberDevicePanelNo(DEV, 21, true);
T.devicePanelNoAt.set(DEV, { no: 21, at: Date.now() - T.DEVICE_PANEL_NO_TTL - 1 });
eq('超过 TTL（心跳 30s 一跳，90s 没信就是掉线）→ 读不到', peek(), null);
eq('过期条目读的时候顺手删除', T.devicePanelNoAt.has(DEV), false);
T.devicePanelNoAt.clear();

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
