// 一次性自检：把墙板配置表里的纯函数从 public/index.html 抠出来跑断言（不起服务、不连库、不动数据）。
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8');
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
const names = ['_wpNums', '_wpDups', '_wpConflicts', '_wpOne', '_wpSnap', '_wpFollowHtml',
  '_wpPath', '_wpBaud', '_wpNoOf'];
// 纯函数之外还要带上它们引用的模块级常量（编号上限、串口节点形状、波特率档）
const code = (src.match(/^var (WP_PANEL_MAX|WP_SERIAL_BAUDS|WP_SERIAL_DEFAULT_PATH|WP_SERIAL_PATH_RE) = .*$/gm).join('\n')
  + '\n' + names.map(grab).join('\n'));
const box = {};
// _wpFollowHtml 是纯函数，但产出的是 HTML 片段，esc 得给它一个真转义（断言里有 < 的场景要看得见）
const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
new Function('exports', 'esc', code + '\nObject.assign(exports,{' + names.join(',') + '});')(box, esc);
const T = box;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label + '\n      got  ' + g + '\n      want ' + w); }
};

console.log('_wpNums:');
eq('整数与数字字符串都收', T._wpNums({ scenes: { A: { panel_no: { '01': 3, '02': '7' } } } }, 'A'), { '01': 3, '02': 7 });
eq('越界/小数/脏类型/数组值丢弃', T._wpNums({ scenes: { A: { panel_no: { '01': 0, '02': 33, '03': 2.5, '04': true, '05': null, '06': [3], '07': 'x' } } } }, 'A'), {});
eq('32 边界保留', T._wpNums({ scenes: { A: { panel_no: { '01': 32 } } } }, 'A'), { '01': 32 });
eq('没配 → 空表', T._wpNums({ scenes: { A: {} } }, 'A'), {});
eq('幕缺失不抛', T._wpNums({ scenes: {} }, 'B'), {});
eq('panel_no 是数组不抛', T._wpNums({ scenes: { A: { panel_no: ['1', '2'] } } }, 'A'), {});
eq('panel_no 是字符串不抛', T._wpNums({ scenes: { A: { panel_no: 'x' } } }, 'A'), {});
eq('config 完全空不抛', T._wpNums({}, 'A'), {});

console.log('_wpDups:');
eq('无冲突 → 空', T._wpDups({ '01': 1, '02': 2 }), {});
eq('两格抢同一个号 → 都标出', T._wpDups({ '01': 3, '02': 3, '03': 4 }), { '01': 3, '02': 3 });
eq('三格抢同一个号 → 全标出', T._wpDups({ '01': 5, '02': 5, '03': 5 }), { '01': 5, '02': 5, '03': 5 });
eq('空表 → 空', T._wpDups({}), {});
eq('幕缺失（undefined）不抛', T._wpDups(undefined), {});

console.log('_wpConflicts:');
eq('两幕各判，跨幕同号不算', T._wpConflicts({ A: { '01': 3 }, B: { '07': 3 } }), []);
eq('A幕冲突 + B幕冲突都列出来', T._wpConflicts({ A: { '01': 3, '02': 3 }, B: { '05': 9, '06': 9 } }),
  ['第一幕 3 号同时绑在 01、02', '第二幕 9 号同时绑在 05、06']);
eq('同编号三格只出一条（键排序稳定）', T._wpConflicts({ A: { '06': 2, '02': 2, '03': 2 } }), ['第一幕 2 号同时绑在 02、03、06']);
eq('全空 → 无冲突', T._wpConflicts({ A: {}, B: {} }), []);
eq('草稿缺某一幕也不抛', T._wpConflicts({ A: { '01': 2, '02': 2 } }), ['第一幕 2 号同时绑在 01、02']);

console.log('_wpOne:');
eq('整数与数字字符串都收', [T._wpOne(7), T._wpOne('7')], [7, 7]);
eq('边界 1 / 32 保留，0 / 33 出局', [T._wpOne(1), T._wpOne(32), T._wpOne(0), T._wpOne(33)], [1, 32, null, null]);
eq('脏值一律当没设', [T._wpOne(''), T._wpOne('x'), T._wpOne(2.5), T._wpOne(null), T._wpOne(undefined), T._wpOne([3]), T._wpOne(true)],
  [null, null, null, null, null, null, null]);

console.log('_wpFollowHtml:');
const has = (label, html, ...needles) => eq(label, needles.every(n => html.includes(n)), true);
const cfgWin = (sc, wins) => ({ scenes: { A: { windows: sc === 'A' ? wins : [] }, B: { windows: sc === 'B' ? wins : [] } } });
const D = { A: { '01': 5, '07': 2 }, B: {} };
has('跟随窗：播哪格交给编号，默认格的编号也标出来',
  T._wpFollowHtml(cfgWin('A', [{ id: 'win_1', name: '主屏', content: { type: 'SCENE_A', folderId: '01', follow: true } }]), D),
  '按编号切换（默认 01）', '5 号（默认）', '>开<');
has('跟随窗默认格没绑编号 → 按任何键都切不回，单独标黄',
  T._wpFollowHtml(cfgWin('A', [{ id: 'win_1', name: '主屏', content: { type: 'SCENE_A', folderId: '12', follow: true } }]), D),
  '按编号切换（默认 12）', '未绑，切不回');
has('跟随窗没填默认格 → 默认自动，编号列留空',
  T._wpFollowHtml(cfgWin('A', [{ id: 'win_1', name: '主屏', content: { type: 'SCENE_A', follow: true } }]), D),
  '按编号切换（默认自动）', '<td>—</td>');
has('固定窗：显示钉死的格 + 那一格的墙板编号',
  T._wpFollowHtml(cfgWin('A', [{ id: 'win_2', name: '副屏', content: { type: 'SCENE_A', folderId: '07' } }]), D),
  '固定 07', '2 号', '>关<');
has('固定窗钉在未绑编号的格上 → 提示未绑',
  T._wpFollowHtml(cfgWin('A', [{ id: 'win_2', name: '副屏', content: { type: 'SCENE_A', folderId: '12' } }]), D),
  '未绑');
has('自动窗（folderId 空）不看编号',
  T._wpFollowHtml(cfgWin('A', [{ id: 'win_3', name: 'A', content: { type: 'SCENE_A' } }]), D),
  '自动（首个有素材文件夹）');
has('HDMI/测试背景窗不进表',
  T._wpFollowHtml(cfgWin('A', [{ id: 'w1', name: 'h', content: { type: 'HDMI', inputIndex: 1 } },
                               { id: 'w2', name: 'c', content: { type: 'color', color: '#f00' } }]), D),
  '这房间还没有播场景的窗口');
has('所在幕与内容类型不符 → 单独报出来，不进表',
  T._wpFollowHtml(cfgWin('A', [{ id: 'win_9', name: '串幕', content: { type: 'SCENE_B', follow: true } }]), D),
  '设备端不认', '串幕（在A幕，内容却是SCENE_B）');
has('小写脏 type 仍认（与服务端/设备端口径一致）',
  T._wpFollowHtml(cfgWin('A', [{ id: 'win_1', name: 'x', content: { type: 'scene_a', follow: true } }]), D),
  '按编号切换');
has('B 幕跟随窗按 B 幕编号查（草稿里 B 空 → 未绑）',
  T._wpFollowHtml(cfgWin('B', [{ id: 'win_1', name: 'y', content: { type: 'SCENE_B', folderId: '01' } }]), D),
  '固定 01', '未绑');
has('窗口名里的尖括号被转义，不会捅破表格',
  T._wpFollowHtml(cfgWin('A', [{ id: 'win_1', name: '<img src=x>', content: { type: 'SCENE_A', follow: true } }]), D),
  '&lt;img src=x&gt;');
eq('windows 不是数组也不抛', (() => {
  try { T._wpFollowHtml({ scenes: { A: { windows: 'x' }, B: {} } }, D); return 'ok'; }
  catch (e) { return 'throw: ' + e.message; }
})(), 'ok');

console.log('_wpSnap:');
const a = { enabled: true, A: { '01': 3, '02': 7 }, B: {} };
const b = { enabled: true, A: { '02': 7, '01': 3 }, B: {} };
eq('键序不同不算改动', T._wpSnap(a), T._wpSnap(b));
eq('总闸变了算改动', T._wpSnap({ enabled: false, A: { '01': 3 }, B: {} }) === T._wpSnap({ enabled: true, A: { '01': 3 }, B: {} }), false);
eq('默认编号变了算改动', T._wpSnap({ enabled: true, defaultNo: 5, A: { '01': 3 }, B: {} }) === T._wpSnap({ enabled: true, defaultNo: null, A: { '01': 3 }, B: {} }), false);
eq('解绑回到基线', T._wpSnap({ enabled: true, A: {}, B: { '05': 1 } }) === T._wpSnap({ enabled: true, A: {}, B: { '05': 1 } }), true);
eq('串口节点换了算改动', T._wpSnap({ enabled: true, A: {}, B: {}, path: '/dev/ttyS1' })
  === T._wpSnap({ enabled: true, A: {}, B: {}, path: '/dev/ttyUSB0' }), false);
eq('波特率换了算改动（含"没设→设了"）', [
  T._wpSnap({ enabled: true, A: {}, B: {}, baud: 19200 }) === T._wpSnap({ enabled: true, A: {}, B: {}, baud: 9600 }),
  T._wpSnap({ enabled: true, A: {}, B: {}, baud: 9600 }) === T._wpSnap({ enabled: true, A: {}, B: {}, baud: null }),
], [false, false]);

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

console.log('_wpNoOf（心跳回传的当前编号，d.panel_no）:');
eq('1~32 整数认，边界都在圈内', [T._wpNoOf({ panel_no: 1 }), T._wpNoOf({ panel_no: '32' }), T._wpNoOf({ panel_no: 32 })], [1, 32, 32]);
eq('越界/脏值/缺失 = 不知道', [T._wpNoOf({ panel_no: 0 }), T._wpNoOf({ panel_no: 33 }), T._wpNoOf({ panel_no: 2.5 }),
  T._wpNoOf({ panel_no: '' }), T._wpNoOf({ panel_no: null }), T._wpNoOf({}), T._wpNoOf(null)],
  [null, null, null, null, null, null, null]);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
