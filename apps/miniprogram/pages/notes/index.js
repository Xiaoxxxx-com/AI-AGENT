const { request, ensureLogin } = require('../../utils/request');

Page({
  data: {
    notes: [],
    title: '',
    content: '',
    keyword: '',
    results: null,
    loading: false,
  },

  onLoad() {
    ensureLogin().then(() => this.loadNotes());
  },

  async loadNotes() {
    try {
      const { items } = await request('/notes?limit=20');
      this.setData({ notes: items || [] });
    } catch (err) {
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onTitle(e) {
    this.setData({ title: e.detail.value });
  },

  onContent(e) {
    this.setData({ content: e.detail.value });
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  async onSave() {
    const content = this.data.content.trim();
    if (!content) {
      wx.showToast({ title: '写点内容', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      await request('/notes', {
        method: 'POST',
        data: { title: this.data.title.trim(), content },
      });
      this.setData({ title: '', content: '' });
      wx.showToast({ title: '已记住', icon: 'none' });
      this.loadNotes();
      // 分词是同步的，向量是异步的，稍等一下再查
      setTimeout(() => this.runSearch(this.data.keyword || content.slice(0, 10)), 1500);
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async onSearch() {
    await this.runSearch(this.data.keyword);
  },

  /** 验证混合检索：结果里的 source 会告诉你命中的是向量路、关键词路还是两路都有 */
  async runSearch(keyword) {
    const q = (keyword || '').trim();
    if (!q) return;
    try {
      const res = await request(`/memory/search?q=${encodeURIComponent(q)}&topK=8`);
      this.setData({
        keyword: q,
        results: {
          items: res.items,
          meta: res.meta,
        },
      });
    } catch (err) {
      wx.showToast({ title: '检索失败', icon: 'none' });
    }
  },
});
