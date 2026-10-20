const { request, ensureLogin } = require('../../utils/request');
const { createSSE } = require('../../utils/sse');
const { TEMPLATE_PROACTIVE } = require('../../config');

let sse = null;
let pendingText = '';
let flushTimer = null;

Page({
  data: {
    messages: [],
    input: '',
    sending: false,
    pendingProactive: null,
    sessionId: '',
    subscribed: false,
  },

  onLoad() {
    let sessionId = wx.getStorageSync('sessionId');
    if (!sessionId) {
      sessionId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      wx.setStorageSync('sessionId', sessionId);
    }
    this.setData({ sessionId });
    ensureLogin()
      .then(() => this.loadHistory())
      .then(() => this.loadPending());
  },

  onUnload() {
    // 不 abort 的话，页面退出后连接还在收流
    if (sse) sse.abort();
    if (flushTimer) clearTimeout(flushTimer);
  },

  async loadHistory() {
    try {
      const { items } = await request(
        `/chat/history?sessionId=${this.data.sessionId}&limit=30`,
      );
      this.setData({
        messages: (items || []).map((i) => ({ role: i.role, text: i.content })),
      });
      this.scrollToBottom();
    } catch (err) {
      console.warn('history failed', err);
    }
  },

  async loadPending() {
    try {
      const { items } = await request('/proactive/pending');
      if (items && items.length) {
        this.setData({ pendingProactive: items[0] });
        await request(`/proactive/${items[0].id}/read`, { method: 'POST' });
      }
    } catch (err) {
      console.warn('pending failed', err);
    }
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  onSend() {
    const text = this.data.input.trim();
    if (!text || this.data.sending) return;

    const messages = this.data.messages.concat([
      { role: 'user', text },
      { role: 'assistant', text: '' },
    ]);
    this.setData({ messages, input: '', sending: true, pendingProactive: null });
    this.scrollToBottom();

    const lastIndex = messages.length - 1;
    let assistantText = '';

    sse = createSSE({
      path: '/chat/stream',
      data: { message: text, sessionId: this.data.sessionId },
      onEvent: (event, payload) => {
        if (event === 'token' && payload.text) {
          assistantText += payload.text;
          this.queueAppend(lastIndex, assistantText);
        } else if (event === 'meta' && payload.sessionId) {
          wx.setStorageSync('sessionId', payload.sessionId);
        }
      },
      onError: () => {
        wx.showToast({ title: '连接中断', icon: 'none' });
      },
      onDone: () => {
        this.flushNow(lastIndex, assistantText);
        this.setData({ sending: false });
        sse = null;
      },
    });
  },

  /** 每 50ms 合并一次 setData：token 级 setData 会把小程序卡死 */
  queueAppend(index, text) {
    pendingText = text;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      this.setData({ [`messages[${index}].text`]: pendingText });
      this.scrollToBottom();
    }, 50);
  },

  flushNow(index, text) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    this.setData({ [`messages[${index}].text`]: text });
    this.scrollToBottom();
  },

  scrollToBottom() {
    wx.nextTick(() => {
      wx.createSelectorQuery()
        .select('#scroll')
        .node()
        .exec(() => {});
    });
    this.setData({ scrollIntoView: 'bottom-anchor' });
  },

  /** 订阅授权必须由用户点击触发，且一次授权通常只能发一条 */
  onSubscribe() {
    if (!TEMPLATE_PROACTIVE) {
      wx.showToast({ title: '未配置模板 ID', icon: 'none' });
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [TEMPLATE_PROACTIVE],
      success: async (res) => {
        if (res[TEMPLATE_PROACTIVE] === 'accept') {
          await request('/proactive/subscribe', { method: 'POST' });
          this.setData({ subscribed: true });
          wx.showToast({ title: '好，她会偶尔想起你', icon: 'none' });
        }
      },
    });
  },

  goNotes() {
    wx.navigateTo({ url: '/pages/notes/index' });
  },
});
