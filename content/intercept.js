// =============================================================================
// 58微聊自动回复 - API 拦截器（运行在 MAIN world，可访问页面原生 fetch/XHR）
// 目的：在 58.com 加载访客数据时，从 JSON 响应中提取真实年龄（未经 PUA 编码）
// 提取的数据通过 window.postMessage 传给 content.js（ISOLATED world）
// =============================================================================

(function () {
  const AGE_CACHE_KEY = '_58_age_cache';

  // 递归搜索 JSON 对象，找到含 ID + 年龄的结构并缓存
  function extractAges(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 7) return;

    const idFields   = ['resumeid', 'resumeId', 'userid', 'userId', 'cuid', 'infoid', 'uid', 'id'];
    const ageFields  = ['age', 'userAge', 'resumeAge', 'nianling', 'realAge', 'candidateAge'];

    let id = null, age = null;
    for (const f of idFields)  { if (obj[f] != null) { id  = String(obj[f]); break; } }
    for (const f of ageFields) {
      if (obj[f] != null) {
        const v = parseInt(obj[f]);
        if (!isNaN(v) && v >= 16 && v <= 70) { age = v; break; }
      }
    }

    if (id && age != null) {
      window.postMessage({ type: '_58_AGE', id, age }, '*');
    }

    if (Array.isArray(obj)) {
      obj.forEach(item => extractAges(item, depth + 1));
    } else {
      Object.values(obj).forEach(v => {
        if (v && typeof v === 'object') extractAges(v, depth + 1);
      });
    }
  }

  // 从 get_chat_records URL 的 base64 params 里提取 chat_user_id
  function extractChatUserId(url) {
    try {
      const b64 = new URL(url, 'https://im.58.com').searchParams.get('params');
      if (!b64) return '';
      const decoded = atob(b64);
      const m = decoded.match(/chat_user_id=([^&\x00-\x1f\x7f]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch { return ''; }
  }

  // 从 get_chat_records 响应里提取简历卡片完整信息
  function extractResumeCards(data, url) {
    if (!url.includes('get_chat_records')) return;

    const chatUserId = extractChatUserId(url);

    const msgList = data?.data?.msg_list;
    if (!Array.isArray(msgList)) return;

    for (const msg of msgList) {
      if (msg.show_type !== 'job_card_12') continue;
      try {
        const content = JSON.parse(msg.content);
        const r = content?.resume_info;
        if (!r || !r.name || !r.phone) continue;

        window.postMessage({
          type: '_58_RESUME',
          resumeid:    r.resumeid    || '',
          name:        r.name,
          phone:       r.phone,
          age:         String(r.age        || ''),
          educational: r.educational || '',
          experience:  r.experience  || '',
          applyjob:    r.applyjob    || '',
          jobState:    r.jobState    || '',
          msgId:       msg.msg_id    || '',
          chatUserId,                        // session 标识，用于匹配 data-key
        }, '*');
      } catch {}
    }
  }

  function tryExtract(text, url) {
    try {
      const data = JSON.parse(text);
      extractAges(data, 0);
      extractResumeCards(data, url);
    } catch {}
  }

  // 拦截 fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const clone = res.clone();
      clone.text().then(text => tryExtract(text, typeof args[0] === 'string' ? args[0] : ''));
    } catch {}
    return res;
  };

  // 拦截 XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._interceptUrl = url;
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try { tryExtract(this.responseText, this._interceptUrl || ''); } catch {}
    });
    return origSend.apply(this, args);
  };

  console.log('[58自动回复] API拦截器已启动');
})();
