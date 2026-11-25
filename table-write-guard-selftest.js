// 一次性自检：播放设置表 / 墙板码值表的「PUT 前比对基线」写入守卫。
// 坑（2026-11-25 生产实测）：两处同时开着编辑页，后保存那份拿的是自己进页时的旧草稿，
// 整表覆盖会把先保存那份刚改的格子当成「用户关掉了」抹掉 —— play_settings 里 logo 全消失即此。
// 改法：落库前 GET 最新 config，按「本处相对基线没动过 → 取云端 / 动过 → 取本处」三方合并再 PUT。
// 改到 _psMergeScene / _wpMergeCodes / _psSaveSnap / _wpAutoSaveCodes / _psAdoptMerged / _wpAdoptCodes
// 任意一处，都要同步改这里（移植失真比没测更糟 —— 它会给出绿的假答案）。
//
// 跑法：node table-write-guard-selftest.js
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[1];

// ---- 最小 DOM 桩（对齐 canvas-view-selftest，够渲染表格与框就行） ----
const el = () => ({
  style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, dataset: {},
  appendChild() {}, insertAdjacentHTML() {}, setAttribute() {}, focus() {}, blur() {}, remove() {},
  closest: () => null, parentNode: null, children: [],
  addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [],
  querySelector: () => null, getContext: () => ({}), value: '', textContent: '',
  innerHTML: '', outerHTML: '', checked: false, clientWidth: 800, clientHeight: 400,
});
const doc = {
  getElementById: () => el(), createElement: () => el(), querySelector: () => null,
  querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  body: el(), documentElement: el(), cookie: '', activeElement: null,
};
const win = { addEventListener() {}, removeEventListener() {}, location: { href: '' }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
const store = { getItem: () => null, setItem() {}, removeItem() {} };

// ---- 假云端：GET 返回当下真值，PUT 整份替换（服务端 mergeSceneConfig 对「带键即落」的行为等价） ----
let cloudCfg = null;
let puts = [];
const fetch = async (url, opts) => {
  const method = (opts && opts.method) || 'GET';
  if (method !== 'PUT') {
    return { ok: true, status: 200, json: async () => ({ id: 'R1', name: '台架房', store_name: '鲸落', config: JSON.stringify(cloudCfg) }) };
  }
  const body = JSON.parse(opts.body);
  cloudCfg = JSON.parse(body.config);
  puts.push(cloudCfg);
  return { ok: true, status: 200, json: async () => ({ success: true }) };
};

const tail = `
;return {
  s: s,
  psDraft: function () { return _psDraftOf(); },
  psSnap: function (d) { return _psSnapForSave(d); },
  psSnapStr: function (d) { return _psSnap(d); },
  psSave: function (snap) { return _psSaveSnap(snap); },
  psMerge: function (b, m, c) { return _psMergeScene(b, m, c); },
  psTables: function (cfg) { return _psTablesOf(cfg); },
  psNorm: function (c) { return _psNorm(c); },
  psDenorm: function (n) { return _psDenorm(n); },
  psDirty: function () { var d = _psDraftOf(); return _psSnap(d) !== d.base; },
  wpDraft: function () { return _wpDraftOf(); },
  wpFlat: function (d) { return _wpFlatOfDraft(d); },
  wpFlatCfg: function (cfg) { return _wpFlatOfCfg(cfg); },
  wpMerge: function (b, m, c) { return _wpMergeCodes(b, m, c); },
  wpAutoSave: function () { return _wpAutoSaveCodes('已录', true); },
  wpSnap: function (d) { var snap = _wpSerialSnap(d); Object.assign(snap.fields, _wpCodeFields(d)); snap.mineCodes = _wpFlatOfDraft(d); snap.baseCodes = d.baseCodes; return snap; },
  wpSave: function (snap) { return _wpSaveSnap(snap); },
};`;
const factory = new Function('window', 'document', 'localStorage', 'location', 'navigator', 'history', 'fetch', 'XMLHttpRequest', 'WebSocket', 'confirm', 'alert', 'prompt', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', src + tail);
const api = factory(win, doc, store, win.location, { userAgent: 'node' }, {}, fetch, function () {}, function () {}, () => true, () => {}, () => '', () => 0, () => {}, () => ({}));

let bad = 0;
/** 键排序后比较：合并结果的格子顺序不参与判定（落库后 rev 由服务端按内容算） */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {});
  return v;
}
function eq(label, got, want) {
  const ok = JSON.stringify(canon(got)) === JSON.stringify(canon(want));
  if (!ok) bad++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + ' => ' + JSON.stringify(canon(got)) + (ok ? '' : ' (want ' + JSON.stringify(canon(want)) + ')'));
}
const cfgOf = (psA, psB, binds, on, off) => ({
  scenes: {
    A: { name: '第一幕', windows: [], folder_mappings: {}, master: {}, play_settings: psA || {} },
    B: { name: '第二幕', windows: [], folder_mappings: {}, master: {}, play_settings: psB || {} }
  },
  wallpanel_bindings: binds || [], wallpanel_on_frame: on || null, wallpanel_off_frame: off || null
});

// 页面缓存 = 草稿的来路；每轮都重建草稿
function enter(cfg) {
  cloudCfg = JSON.parse(JSON.stringify(cfg));
  api.s.rooms = [{ id: 'R1', name: '台架房', store_name: '鲸落', config: JSON.stringify(cfg) }];
  api.s.rf = 'R1';
  api.s._psMode = true; api.s._psDraft = null;
  api.s._wpMode = true; api.s._wpDraft = null;
  puts = [];
}

// ============================================================================
// 一、纯函数：归一往返 + 三方合并的规则本身
// ============================================================================
eq('四元组往返：{hdmi:true} 不加 hdmi_mode', api.psDenorm(api.psNorm({ hdmi: true })), { hdmi: true });
eq('四元组往返：模式3', api.psDenorm(api.psNorm({ hdmi: true, hdmi_mode: 3 })), { hdmi: true, hdmi_mode: 3 });
eq('四元组往返：随机+LOGO', api.psDenorm(api.psNorm({ order: 'shuffle', logo: true })), { order: 'shuffle', logo: true });
eq('四元组往返：全默认 → null 不落键', api.psDenorm(api.psNorm({ order: 'seq' })), null);
eq('四元组：空格子 = null', api.psNorm(undefined), null);

// 单页操作（云端 == 基线）：合并必须与「整表覆盖」逐字节相同，守卫对它是恒等的
eq('合并：无冲突 = 草稿原样',
  api.psMerge({ '03': { logo: true } }, { '03': { logo: true }, '05': { dmx: true } }, { '03': { logo: true } }),
  { table: { '03': { logo: true }, '05': { dmx: true } }, kept: 0 });
// 本处没动、别处新开了一格 → 取云端（这就是 logo 被抹那一坑的止血点）
eq('合并：别处新开的格保住',
  api.psMerge({ '03': { logo: true } }, { '03': { logo: true } }, { '03': { logo: true }, '07': { logo: true } }),
  { table: { '03': { logo: true }, '07': { logo: true } }, kept: 1 });
// 本处没动、别处关掉了 → 同样取云端，不拿旧草稿把人家关掉的又打开
eq('合并：别处关掉的格不复活',
  api.psMerge({ '03': { logo: true }, '07': { logo: true } }, { '03': { logo: true }, '07': { logo: true } }, { '03': { logo: true } }),
  { table: { '03': { logo: true } }, kept: 1 });
// 本处动过的格子以本处为准（同一格两人各改各的，最后落库这份说了算）
eq('合并：本处动过的格子赢',
  api.psMerge({ '03': { logo: true } }, { '03': {} }, { '03': { logo: true }, '07': { dmx: true } }),
  { table: { '07': { dmx: true } }, kept: 1 });
eq('合并：本处改顺序、别处改同格 LOGO → 本处那一笔覆盖整格',
  api.psMerge({ '03': { logo: true } }, { '03': { logo: true, order: 'shuffle' } }, { '03': { logo: true } }),
  { table: { '03': { logo: true, order: 'shuffle' } }, kept: 0 });
// 只有一侧有键也要并进来（键集是三方并集，不是「草稿那几行」）
eq('合并：云端独有、本处全空的格子保留',
  api.psMerge({}, {}, { '12': { order: 'shuffle' } }), { table: { '12': { order: 'shuffle' } }, kept: 1 });

eq('码值合并：本处没录、别处新录的码保住',
  api.wpMerge({ '01|panel': 'D3' }, { '01|panel': 'D3' }, { '01|panel': 'D3', '02|panel': 'F5' }),
  { flat: { '01|panel': 'D3', '02|panel': 'F5' }, kept: 1 });
eq('码值合并：本处重录的码以本处为准',
  api.wpMerge({ '01|panel': 'D3' }, { '01|panel': 'D4' }, { '01|panel': 'D3' }),
  { flat: { '01|panel': 'D4' }, kept: 0 });
eq('码值合并：本处清掉 = 清掉（别处同格另一列不受影响）',
  api.wpMerge({ '01|panel': 'D3', '01|player': 'AA' }, { '01|player': 'AA' }, { '01|panel': 'D3', '01|player': 'AA' }),
  { flat: { '01|player': 'AA' }, kept: 0 });
eq('码值合并：全开/全关码也算一格（伪格名 ON/OFF）',
  api.wpMerge({}, {}, { 'ON|panel': 'AABB', '03|panel': 'D3' }),
  { flat: { 'ON|panel': 'AABB', '03|panel': 'D3' }, kept: 2 });
eq('码值扁平：脏值不算码', api.wpFlatCfg({ wallpanel_bindings: [{ frame: 'ZZ', folder: '01', source: 'panel' }], wallpanel_on_frame: '' }), {});

// ============================================================================
// 二、写库通路：拿 GET 到的最新 config 合并后再 PUT，落库真值回填草稿与基线
// ============================================================================
(async () => {
  // 坑复现：缓存里带 logo:true，别处（这里假成云端）已经被整表刷成 dmx-only；
  // 本处只改 05 的顺序 —— 老写法会把云端剩的那几格一起抹掉。
  const base = cfgOf({ '10': { dmx: true }, '11': { dmx: true }, '03': { logo: true } }, { '03': { logo: true } });
  enter(base);
  // 别处先改：云端 10 的 dmx 关掉、新增 07 的 logo 开
  cloudCfg.scenes.A.play_settings = { '11': { dmx: true }, '03': { logo: true }, '07': { logo: true } };
  let d = api.psDraft();                       // 草稿来自页面缓存（= 旧的 base）
  d.A['05'] = { order: 'shuffle' };            // 本处只动这一格
  let err = await api.psSave(api.psSnap(d));
  eq('落库：无报错', err, null);
  eq('落库：本处改的格 + 云端改的格都在',
    puts[0].scenes.A.play_settings, { '03': { logo: true }, '05': { order: 'shuffle' }, '07': { logo: true }, '11': { dmx: true } });
  eq('落库：B 幕照样整幕带上（没冲突时就是草稿原样）', puts[0].scenes.B.play_settings, { '03': { logo: true } });
  eq('落库后：草稿看到别处的格子', api.psDraft().A['07'], { logo: true });
  eq('落库后：基线 = 落库真值', api.psDraft().base,
    api.psSnapStr({ A: puts[0].scenes.A.play_settings, B: puts[0].scenes.B.play_settings }));
  eq('落库后：无未保存改动', api.psDirty(), false);

  // 路上又改的格子：这一笔不在快照里，标记要继续亮，值不能被落库结果顶掉
  enter(base);
  cloudCfg.scenes.A.play_settings = { '03': { logo: true }, '07': { logo: true } };
  d = api.psDraft();
  d.A['05'] = { order: 'shuffle' };
  const snap = api.psSnap(d);
  d.A['06'] = { logo: true };                  // GET→PUT 在飞的途中又拨了一格
  await api.psSave(snap);
  eq('在飞途中改的格子：值保住', api.psDraft().A['06'], { logo: true });
  eq('在飞途中改的格子：标记继续亮', api.psDirty(), true);
  await api.psSave(api.psSnap(api.psDraft()));
  eq('下一笔自动保存把补上的格子落库', puts[1].scenes.A.play_settings['06'], { logo: true });
  eq('下一笔之后：云端独有的格子还在', puts[1].scenes.A.play_settings['07'], { logo: true });

  // 单页操作（云端 == 基线）：行为与整表覆盖一致，不引入新差异
  enter(base);
  d = api.psDraft();
  d.A['03'] = null; delete d.A['03'];          // 本处关掉 LOGO
  await api.psSave(api.psSnap(d));
  eq('单页关格子：照常落库（守卫不拦）', puts[0].scenes.A.play_settings['03'], undefined);

  // 墙板码值表：同一条路
  const wpBase = cfgOf({}, {}, [{ frame: 'D3', folder: '01', source: 'panel' }]);
  enter(wpBase);
  cloudCfg.wallpanel_bindings = [{ frame: 'D3', folder: '01', source: 'panel' }, { frame: 'F5', folder: '02', source: 'player' }];
  const wd = api.wpDraft();
  wd.code['05'] = { panel: 'AA' };             // 本处只录 05 的墙板码
  await api.wpAutoSave();
  const sent = puts[0].wallpanel_bindings;
  eq('墙板：本处新录的码在', sent.filter(r => r.folder === '05'), [{ frame: 'AA', folder: '05', source: 'panel' }]);
  eq('墙板：别处新录的码没被整表抹掉', sent.filter(r => r.folder === '02'), [{ frame: 'F5', folder: '02', source: 'player' }]);
  eq('墙板：草稿看到别处那条码', api.wpDraft().code['02'], { player: 'F5' });
  eq('墙板：基线跟着落库真值', api.wpDraft().baseCodes, { '01|panel': 'D3', '02|player': 'F5', '05|panel': 'AA' });

  // 「保存」按钮那条路（串口 + 码值一起写）同样走合并
  enter(wpBase);
  cloudCfg.wallpanel_on_frame = 'AABB';        // 别处录了全开码
  const snap2 = api.wpSnap(api.wpDraft());
  snap2.fields.wallpanel_baud = 9600;
  await api.wpSave(snap2);
  eq('保存按钮：串口参数照落', puts[0].wallpanel_baud, 9600);
  eq('保存按钮：别处录的全开码没被抹掉', puts[0].wallpanel_on_frame, 'AABB');

  console.log('\n' + (bad ? 'FAIL ' + bad + ' 条' : '全部通过'));
  process.exit(bad ? 1 : 0);
})();
