/**
 * SSE over wx.request(enableChunked)。
 * 三个必须做对的点：
 * 1. TextDecoder 要带 { stream: true }，否则一个汉字被切在两个 chunk 之间会乱码；
 * 2. 必须按 \n\n 切事件，不能按 chunk 切（一个事件可能跨多个 chunk）；
 * 3. 页面 onUnload 要 abort，否则后台一直在收流。
 */
let decoder;
try {
  decoder = new TextDecoder('utf-8');
} catch (e) {
  const { TextDecoder: Polyfill } = require('text-encoding');
  decoder = new Polyfill('utf-8');
}

function createSSE({ path, data, onEvent, onError, onDone, onOpen }) {
  const { BASE_URL } = require('../config');
  let buffer = '';
  let closed = false;

  const task = wx.request({
    url: `${BASE_URL}${path}`,
    method: 'POST',
    data,
    enableChunked: true,
    responseType: 'arraybuffer',
    timeout: 120000,
    header: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${wx.getStorageSync('token')}`,
    },
    success: () => {
      if (!closed) onOpen && onOpen();
    },
    fail: (err) => {
      if (!closed) onError && onError(err);
    },
  });

  if (!task.onChunkReceived) {
    // 低版本基础库没有分块接收，退化为一次性读完
    onError && onError(new Error('当前基础库不支持 enableChunked，请升级微信或在后端提供 /chat/ws'));
    return { abort() {} };
  }

  task.onChunkReceived(({ data: chunk }) => {
    if (closed) return;
    buffer += decoder.decode(new Uint8Array(chunk), { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let event = 'message';
      let payload = '';
      block.split('\n').forEach((line) => {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) payload += line.slice(5).trim();
      });
      if (!payload) continue;

      try {
        const parsed = JSON.parse(payload);
        onEvent && onEvent(event, parsed);
        if (event === 'done') {
          closed = true;
          onDone && onDone(parsed);
        }
      } catch (e) {
        onError && onError(e);
      }
    }
  });

  return {
    abort() {
      closed = true;
      try {
        task.abort();
      } catch (e) {
        /* ignore */
      }
    },
  };
}

module.exports = { createSSE };
