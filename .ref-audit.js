// 一次性审计：index.html 内联 handler / 定时器里调用的函数名，是否都有定义
// 用法: node .ref-audit.js public/index.html
const fs = require('fs');
const src = fs.readFileSync(process.argv[2] || 'public/index.html', 'utf8');
const names = new Set();
// 1) 内联事件属性里出现的 `fn(`
for (const m of src.matchAll(/\bon[a-z]+="([^"]*)"/g))
  for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) names.add(n[1]);
// 2) setInterval / setTimeout 的第一个实参
for (const m of src.matchAll(/set(?:Interval|Timeout)\(\s*(?:function\s*\(\s*\)\s*\{|)([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
for (const m of src.matchAll(/set(?:Interval|Timeout)\(\s*([A-Za-z_$][\w$]*)\s*,/g)) names.add(m[1]);
const KW = new Set(['if','for','while','switch','catch','return','function','typeof','new','delete','void','do','else','await','async','String','Number','Boolean','Object','Array','JSON','parseInt','parseFloat','isNaN','setTimeout','setInterval','clearInterval','clearTimeout','alert','confirm','prompt','encodeURIComponent','decodeURIComponent','Date','Math','RegExp','focus','blur','getElementById','querySelector','querySelectorAll','getAttribute','has','test','push','map','filter','forEach','join','split','trim','replace','includes','indexOf','slice','sort','toFixed','then','catch','match','matchAll','some','every','find','keys','values','entries','padStart','repeat','toLowerCase','toUpperCase','isArray','stringify','parse','from','of','assign','create','freeze','hasOwnProperty','toString','valueOf','add','remove','toggle','contains','item','append','insertAdjacentHTML','innerHTML','outerHTML','addEventListener','removeEventListener','preventDefault','stopPropagation','click','scrollIntoView','getBoundingClientRect','requestAnimationFrame','Blob','URL','FileReader','Worker','Set','Map','WeakMap','Promise','Error','btoa','atob','structuredClone','setTimeout']);
const defined = n =>
  new RegExp('function\\s+' + n + '\\s*\\(|(var|let|const)\\s+' + n + '\\s*[=,(]|(var|let|const)\\s*\\{[^}]*\\b' + n + '\\b', 'm').test(src) ||
  new RegExp('window\\.' + n + '\\s*=').test(src);
const missing = [...names].filter(n => !KW.has(n) && !defined(n));
console.log('调用的函数名 ' + names.size + ' 个；未定义 ' + missing.length + ' 个');
missing.forEach(n => {
  const line = src.slice(0, src.indexOf(n)).split('\n').length;
  console.log('  MISS ' + n + ' (首次出现约第 ' + line + ' 行)');
});
process.exit(missing.length ? 1 : 0);
