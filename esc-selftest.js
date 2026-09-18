// 一次性单测：证明 escJsA 产出的字符串放进内联 handler 的单引号 JS 串里不会被提前闭合。
// 不用 eval：属性值解码后手工扫描 + 手工按 JS 字面量规则反解析，比较往返是否等值。
const fs = require('fs');
const src = fs.readFileSync('public/index.html', 'utf8');
const grab = (name) => { const i = src.indexOf('function ' + name + '('); return src.slice(i, src.indexOf('\n}', i) + 2); };
const env = new Function(grab('esc') + '\n' + grab('escA') + '\n' + grab('escJsA') + '\nreturn {esc, escA, escJsA};')();
const { esc, escA, escJsA } = env;

// 浏览器解码 HTML 属性实体
const htmlDecode = (a) => a.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// 按 JS 单引号字面量规则反解析（只处理 escJsA 会产出的五种转义）
const jsUnquote = (s) => {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      out += n === 'n' ? '\n' : n === 'r' ? '\r' : n;
      i += 2;
      continue;
    }
    if (c === "'") return { closedEarly: true, out };   // 未转义的单引号 = 字符串在这里结束
    out += c; i++;
  }
  return { closedEarly: false, out };
};

const cases = ["O'Neil", 'a"><b>x', 'back\\slash', 'tab\tnl\nend', 'A&B', '中文 <tag>', '', "';x='y", "\\\\'", 'x&y"z'];
let fail = 0;
// 数字/布尔/零值：|| 判空会把它们吞成空串（窗口 x=0 的输入框变空白就是这么来的）
const falsyKeep = [[0, '0'], [false, 'false'], ['', ''], [null, ''], [undefined, ''], [0.5, '0.5']];
for (const [v, want] of falsyKeep) {
  const got = esc(v);
  if (got !== want) { console.log('FAIL esc(' + String(v) + ') =', JSON.stringify(got), '期望', JSON.stringify(want)); fail++; }
  else console.log('OK  数字/布尔保真: ' + String(v) + ' -> ' + JSON.stringify(got));
  if (escA(v) !== want) { console.log('FAIL escA(' + String(v) + ') =', JSON.stringify(escA(v))); fail++; }
}
for (const c of cases) {
  const attr = escJsA(c);
  const decoded = htmlDecode(attr);            // 交给 JS 引擎前 HTML 已经还原成什么
  const { closedEarly, out } = jsUnquote(decoded);
  if (/[\r\n]/.test(decoded)) { console.log('FAIL 属性里残留裸换行:', JSON.stringify(c)); fail++; }
  if (closedEarly) { console.log('FAIL 可提前闭合:', JSON.stringify(c), '->', JSON.stringify(decoded)); fail++; }
  else if (out !== c) { console.log('FAIL 往返不等值:', JSON.stringify(c), '->', JSON.stringify(out)); fail++; }
  else console.log('OK  ' + JSON.stringify(c) + '  →  ' + JSON.stringify(attr));
}
// esc / escA 的边界：文本节点不得留标签，属性不得留裸引号
for (const c of cases) {
  if (/[<>]/.test(esc(c))) { console.log('FAIL esc 漏标签:', JSON.stringify(c)); fail++; }
  if (/["']/.test(escA(c))) { console.log('FAIL escA 漏引号:', JSON.stringify(c)); fail++; }
}
console.log(fail ? '--- 结果: ' + fail + ' 处失败'
  : '--- 结果: ' + cases.length + ' 组转义往返用例 + ' + falsyKeep.length + ' 组数字/布尔保真用例，全部通过');
process.exit(fail ? 1 : 0);
