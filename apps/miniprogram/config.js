/**
 * 环境配置。
 * 开发：填本机局域网 IP（真机调试时 127.0.0.1 指向手机自己）
 * 生产：必须是 HTTPS + 已备案域名，且在小程序后台配好 request 合法域名
 */
module.exports = {
  BASE_URL: 'http://127.0.0.1:3000',
  // 订阅消息模板 ID，需与后端 WECHAT_TEMPLATE_PROACTIVE 一致
  TEMPLATE_PROACTIVE: '',
};
