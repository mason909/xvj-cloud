// 【S-14】写接口鉴权链路的实地探针：会话 cookie / x-api-key / 401 语义 / 登录节流。
// Run from /var/www/xvj:  node auth-selftest.js
// 只建一个 ZZAUTH 前缀的临时客户并在结束时删掉；绝不用真实房间做写测试。
const http = require('http');
const config = require('./config');

const PW = config.adminPassword;
const KEY = config.apiKey;

// cookie 要手工管：node 的 http 没有浏览器那套 jar
function req(method, path, body, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (opts.key) headers['x-api-key'] = opts.key;
    if (opts.cookie) headers['cookie'] = opts.cookie;
    if (opts.xff) headers['x-forwarded-for'] = opts.xff;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: config.port || 3000, path, method, headers }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch (e) { }
        resolve({ code: res.statusCode, j, buf, setCookie: res.headers['set-cookie'] || [] });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + ' << ' + detail); } };

// 一个安全的写动作：建幂等测试客户（已存在也只回 existed），最后删掉
const STORE = 'ZZAUTHTEST';
const safeWrite = (o) => req('POST', '/api/stores', { name: STORE }, o);
const code = (r) => r.code;
const loginCodeOf = (r) => (r.j && r.j.code) || '';

(async () => {
  if (!PW) { console.log('跳过：服务端未配置 ADMIN_PASSWORD（/etc/xvj/web.env）'); process.exit(0); }
  if (!KEY) { console.log('跳过：服务端未配置 API_KEY'); process.exit(0); }

  console.log('== 1) 读接口不要求凭据');
  check('GET /api/rooms 无凭据 -> 200', code(await req('GET', '/api/rooms')) === 200, '');

  console.log('== 2) 未登录的写请求：401 + LOGIN_REQUIRED（前端据此弹口令框）');
  let r = await safeWrite({});
  check('写无凭据 -> 401', code(r) === 401, r.code + ' ' + r.buf);
  check('401 带 code=LOGIN_REQUIRED', loginCodeOf(r) === 'LOGIN_REQUIRED', r.buf);

  console.log('== 3) x-api-key 通道');
  r = await safeWrite({ key: KEY });
  check('写带正确 key -> 200', code(r) === 200, r.code + ' ' + r.buf);
  r = await safeWrite({ key: KEY + 'x' });
  check('写带非当前 key -> 401', code(r) === 401, r.code + '（若这里 200，说明 API_KEY 没轮换）');

  console.log('== 4) 口令登录');
  r = await req('POST', '/api/session', { password: 'definitely-not-the-password' });
  check('错口令 -> 401', code(r) === 401, r.code + ' ' + r.buf);
  r = await req('POST', '/api/session', { password: '' });
  check('空口令 -> 400', code(r) === 400, r.code);
  r = await req('POST', '/api/session', {});
  check('不带 password -> 400', code(r) === 400, r.code);

  r = await req('POST', '/api/session', { password: PW });
  check('正确口令 -> 200', code(r) === 200, r.code + ' ' + r.buf);
  const sc = (r.setCookie[0] || '');
  check('Set-Cookie 含 HttpOnly', /HttpOnly/i.test(sc), sc);
  check('Set-Cookie 含 SameSite=Lax', /SameSite=Lax/i.test(sc), sc);
  check('Set-Cookie 含 Max-Age=43200', /Max-Age=43200/.test(sc), sc);
  const COOKIE = sc.split(';')[0];
  check('cookie 名 = xvj_session', COOKIE.indexOf('xvj_session=') === 0, COOKIE);

  console.log('== 5) 会话生效');
  r = await req('GET', '/api/session', null, { cookie: COOKIE });
  check('GET /api/session 已登录 -> authed:true', r.j && r.j.authed === true, r.buf);
  check('回话带 expires_at', !!(r.j && r.j.expires_at), r.buf);
  r = await req('GET', '/api/session');
  check('GET /api/session 未登录 -> authed:false', r.j && r.j.authed === false, r.buf);
  r = await safeWrite({ cookie: COOKIE });
  check('写带会话 cookie -> 200', code(r) === 200, r.code + ' ' + r.buf);

  console.log('== 6) cookie 篡改');
  const bad = COOKIE.slice(0, COOKIE.length - 2) + (COOKIE.slice(-2) === 'AA' ? 'BB' : 'AA');
  r = await safeWrite({ cookie: bad });
  check('改签名尾部 -> 401', code(r) === 401, r.code);
  r = await safeWrite({ cookie: 'xvj_session=' });
  check('空会话值 -> 401', code(r) === 401, r.code);

  console.log('== 7) 登出');
  r = await req('DELETE', '/api/session', null, { cookie: COOKIE });
  check('DELETE /api/session -> 200', code(r) === 200, r.code);
  check('登出回 Max-Age=0', /Max-Age=0/.test((r.setCookie[0] || '')), r.setCookie[0] || '');
  r = await safeWrite({ cookie: COOKIE });
  check('服务端不认 cookie 本身：登出后仍能用（只清浏览器侧）', code(r) === 200, r.code);

  console.log('== 8) 登录节流（用隔离的 XFF 源，不锁 127.0.0.1）');
  const SRC = '203.0.113.201';   // TEST-NET-3，不会被真实流量命中
  let last = null;
  for (let i = 0; i < 9; i++) last = await req('POST', '/api/session', { password: 'nope' + i }, { xff: SRC });
  check('连错 9 次后 -> 429', code(last) === 429, last.code + ' ' + last.buf);
  r = await req('POST', '/api/session', { password: PW }, { xff: SRC });
  check('被锁期间正确口令也 429', code(r) === 429, r.code);
  r = await req('POST', '/api/session', { password: PW }, { xff: '203.0.113.202' });
  check('换一个源不受影响 -> 200', code(r) === 200, r.code);

  console.log('== 9) 清理');
  r = await safeWrite({ key: KEY });
  check('测试客户仍在（节流期间没被写坏）', code(r) === 200, r.code);
  r = await req('DELETE', '/api/stores/' + encodeURIComponent(STORE), null, { key: KEY });
  check('删除测试客户 -> 200', code(r) === 200, r.code + ' ' + r.buf);

  console.log('\n结果: PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('探针异常:', e.message); process.exit(2); });
