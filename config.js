// 服务器配置
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
  
  // API 认证密钥
  apiKey: process.env.API_KEY || 'xvj_secret_key_2024',
  
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
