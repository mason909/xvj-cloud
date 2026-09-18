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
const names = ['prefixedFolderKey', 'normalizeMaterialIds', 'isSceneKey', 'isPlainObject',
  'normalizeFolderMappings', 'mergeSceneConfig', 'buildPrefixedScenes', 'mergePrefixedMappings',
  'roomSceneDigest', 'isSafeDeviceId', 'parseRoomConfig', 'isSafeFolderName'];
const code = names.map(grab).join('\n');
const sandbox = {};
new Function('exports', 'crypto', code + '\nObject.assign(exports, {' + names.join(',') + '});')(sandbox, crypto);
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

console.log('mergePrefixedMappings:');
eq('同前缀键合并去重（A 里写了 B01 时与 B 的 B01 并起来）',
  T.mergePrefixedMappings({ A: { folder_mappings: { A01: ['x', 'y'], B01: ['shared'] } }, B: { folder_mappings: { B01: ['shared', 'z'] } } }),
  { A01: ['x', 'y'], B01: ['shared', 'z'] });
eq('脏值不抛', T.mergePrefixedMappings({ A: { folder_mappings: { A01: 5 } }, B: { folder_mappings: { B01: 'str' } } }), { A01: [], B01: ['str'] });
eq('入参为 undefined 不抛', T.mergePrefixedMappings(undefined), {});

console.log('mergeSceneConfig:');
const ex = { name: '第一幕', folder_mappings: { '01': ['keep'] }, windows: [{ id: 'w1', name: 'W1' }], master: { brightness: 0.4 } };
eq('未带 scenes → 全继承 DB', T.mergeSceneConfig(undefined, ex, '第一幕'), ex);
eq('显式 {} 清空映射', T.mergeSceneConfig({ folder_mappings: {} }, ex, '第一幕').folder_mappings, {});
eq('显式 null 清空映射', T.mergeSceneConfig({ folder_mappings: null }, ex, '第一幕').folder_mappings, {});
eq('空 windows 数组不覆盖（清空走 PUT /windows）', T.mergeSceneConfig({ windows: [] }, ex, '第一幕').windows, ex.windows);
eq('非空 windows 覆盖', T.mergeSceneConfig({ windows: [{ id: 'n', name: 'N' }] }, ex, '第一幕').windows, [{ id: 'n', name: 'N' }]);
eq('master clamp 上界', T.mergeSceneConfig({ master: { brightness: 3 } }, ex, '第一幕').master, { brightness: 1 });
eq('master 非数字 → 0', T.mergeSceneConfig({ master: { brightness: 'hi' } }, ex, '第一幕').master, { brightness: 0 });
eq('incoming 是字符串也不抛', T.mergeSceneConfig('x', ex, '第一幕'), ex);

console.log('roomSceneDigest:');
const r1 = T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [] } } });
eq('与脏键无关', T.roomSceneDigest(JSON.parse('{"scenes":{"A":{"folder_mappings":{"01":["x"]},"windows":[]},"__proto__":{"windows":[1]}}}')), r1);
eq('稳定（重复调用一致）', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['x'] }, windows: [] } } }), r1);
eq('内容不同则 rev 不同', T.roomSceneDigest({ scenes: { A: { folder_mappings: { '01': ['y'] }, windows: [] } } }) !== r1, true);
eq('config 为 null 不抛', typeof T.roomSceneDigest(null), 'string');

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

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
