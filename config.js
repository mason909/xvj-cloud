// 服务器配置
//
// 凭据只从环境读，仓库里不留明文。正常来源是 systemd 的 EnvironmentFile
// （/etc/xvj/mqtt.env、/etc/xvj/web.env），但手工在生产机上跑自测/探针脚本时 node 吃不到
// systemd 注入的环境，所以这里把这两个文件再读一遍补进 process.env —— 少了这一步，
// 「服务器上直接 node xxx-selftest.js」会因为拿不到 API_KEY 全线 401，看起来像代码坏了。
const fs = require('fs');

function loadEnvFile(p) {
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { return; }   // 开发机没有这两个文件，属正常
  txt.split(/\r?\n/).forEach((line) => {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) return;
    const v = m[2].replace(/^["']/, '').replace(/["']$/, '').trim();
    // 空值不覆盖：MQTT_USERNAME= 这种"显式留空"的行不该把未定义变成空串
    if (v !== '' && process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}
loadEnvFile('/etc/xvj/mqtt.env');
loadEnvFile('/etc/xvj/web.env');

module.exports = {
  // 服务器地址 (用于前端和设备)
  serverUrl: process.env.SERVER_URL || 'http://47.102.106.237',

  // MQTT 配置
  mqtt: {
    host: process.env.MQTT_HOST || '47.102.106.237',
    port: parseInt(process.env.MQTT_PORT) || 1883,
    username: process.env.MQTT_USERNAME || '',
    password: process.env.MQTT_PASSWORD || ''
  },

  // API 认证密钥：现在只发给脚本/机器客户端（浏览器改走 /api/session 登录，见 server.js【S-14】）。
  // 刻意没有默认值 —— 拿不到 API_KEY 时写接口一律拒（fail closed），
  // 否则就等于回退到那把曾公开在 index.html 与 git 历史里的 key。
  apiKey: process.env.API_KEY || '',

  // 管理台登录口令（POST /api/session）。没有默认值：未配置时登录回 503，
  // 且所有会话 cookie 一律判无效 —— 绝不能出现"空口令也能进"。
  adminPassword: process.env.ADMIN_PASSWORD || '',

  // 数据库配置
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    name: process.env.DB_NAME || 'xvj_db',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || ''
  },

  // 端口
  port: parseInt(process.env.PORT) || 3000
};
