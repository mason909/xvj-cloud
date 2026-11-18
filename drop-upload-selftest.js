// 一次性自检：把素材页「拖拽上传」的事件接线从 public/index.html 抠出来跑断言（不起服务、不连库、不上传）。
// 这块的风险全在「什么时候接管」：别的页面不能吞掉浏览器默认行为，预览弹层开着不能误传，松手才发一次。
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');

const start = src.indexOf('// 【F-03c】');
if (start < 0) throw new Error('未找到 【F-03c】拖拽上传');
const endMark = "document.addEventListener('dragend'";
const end = src.indexOf(endMark, start);
if (end < 0) throw new Error('未找到 dragend 兜底');
const block = src.slice(start, src.indexOf('\n', end) + 1);

function mkEl() { return { style: { display: 'none' }, innerText: '', classList: { list: [], contains: function(c) { return this.list.indexOf(c) >= 0; } } }; }

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  XX  ' + label + '\n      got  ' + g + '\n      want ' + w); }
};

function mkEnv(materialPage, modalOpen) {
  const els = { dropVeil: mkEl(), dropVeilTxt: mkEl(), m: mkEl() };
  if (modalOpen) els.m.classList.list.push('show');
  const doc = {
    handlers: {},
    addEventListener: function(t, f) { this.handlers[t] = f; },
    getElementById: function(id) { return els[id] || null; },
    documentElement: { contains: function() { return true; } }
  };
  const s = { p: materialPage ? 'materials' : 'devices', f: '07' };
  const h = { uploads: [] };
  const ul = function(files) { h.uploads.push(files); };
  new Function('document', 's', 'ul', block + '\nreturn null;')(doc, s, ul);
  h.doc = doc; h.els = els; h.s = s;
  return h;
}

const ev = (types, files, target) => ({
  dp: false, target: target || {},
  dataTransfer: { types: types, files: files || [], dropEffect: '' },
  preventDefault: function() { this.dp = true; }
});

console.log('dragover：只在素材页接管');
{
  const E = mkEnv(true);
  const e = ev(['Files']);
  E.doc.handlers.dragover(e);
  eq('拦掉浏览器默认的"打开文件"', e.dp, true);
  eq('光标给复制语义', e.dataTransfer.dropEffect, 'copy');
  eq('遮罩亮起，并写明落到哪个文件夹', [E.els.dropVeil.style.display, E.els.dropVeilTxt.innerText], ['flex', '松手上传到 07 文件夹']);
  eq('这一下不上传', E.uploads.length, 0);
}
{
  const E = mkEnv(false);
  const e = ev(['Files']);
  E.doc.handlers.dragover(e);
  eq('别的页面不拦默认行为', e.dp, false);
  eq('别的页面不亮遮罩', E.els.dropVeil.style.display, 'none');
  const d = ev(['Files'], [{ name: 'a.mp4' }]);
  E.doc.handlers.drop(d);
  eq('别的页面松手也不接（不 preventDefault、不传）', [d.dp, E.uploads.length], [false, 0]);
}
{
  const E = mkEnv(true);
  const e = ev(['text/plain']);
  E.doc.handlers.dragover(e);
  eq('拖文本/拖选区不当文件', [e.dp, E.els.dropVeil.style.display], [false, 'none']);
}
{
  const E = mkEnv(true, true);
  const e = ev(['Files']);
  E.doc.handlers.dragover(e);
  E.doc.handlers.drop(Object.assign(ev(['Files'], [{ name: 'a.mp4' }])));
  eq('预览弹层开着不接管（防误传）', [e.dp, E.els.dropVeil.style.display, E.uploads.length], [false, 'none', 0]);
}

console.log('drop：松手才发，一次一发');
{
  const E = mkEnv(true);
  E.doc.handlers.dragover(ev(['Files']));
  const files = [{ name: 'a.mp4' }, { name: 'b.jpg' }];
  const d = ev(['Files'], files);
  E.doc.handlers.drop(d);
  eq('松手拦掉默认行为并收遮罩', [d.dp, E.els.dropVeil.style.display], [true, 'none']);
  eq('文件原样交给 ul()（多选一次进一条队列）', E.uploads.length === 1 && E.uploads[0] === files, true);
}
{
  const E = mkEnv(true);
  const d = ev(['Files'], []);
  E.doc.handlers.drop(d);
  eq('空 FileList 不发请求', [d.dp, E.uploads.length], [true, 0]);
}

console.log('dragleave：掠过子元素不闪，离开文档才收');
{
  const E = mkEnv(true);
  E.doc.handlers.dragover(ev(['Files']));
  E.doc.handlers.dragleave({ relatedTarget: { still: 'inside' } });
  eq('还在页面里 → 遮罩留着', E.els.dropVeil.style.display, 'flex');
  E.doc.handlers.dragleave({ relatedTarget: null });
  eq('离开文档 → 收起', E.els.dropVeil.style.display, 'none');
}
{
  const E = mkEnv(true);
  E.doc.handlers.dragover(ev(['Files']));
  E.doc.handlers.dragend({});
  eq('Esc 取消/拖出窗口的 dragend 兜底', E.els.dropVeil.style.display, 'none');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
