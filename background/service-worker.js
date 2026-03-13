// =============================================================================
// 58微聊自动回复 - Service Worker
// 关键词匹配引擎 + 配置管理 + 限速
// =============================================================================

// --- QQ 通知配置 ---
const QQ_CONFIG = {
  apiUrl: 'http://127.0.0.1:3000/send_group_msg',
  groupId: 1048890155,
};

// --- 默认配置 ---
const DEFAULT_CONFIG = {
  enabled: true,
  rules: [
    {
      id: '1',
      keywords: ['你好', '您好', 'hello', 'hi'],
      reply: '您好！感谢您的关注，请问有什么可以帮您的？',
      matchMode: 'fuzzy', // exact | fuzzy
    },
    {
      id: '2',
      keywords: ['工资', '薪资', '薪水', '待遇', '多少钱'],
      reply: '具体薪资面议，我们会根据您的经验和能力给出合理的待遇，欢迎来面试详谈。',
      matchMode: 'fuzzy',
    },
    {
      id: '3',
      keywords: ['地址', '在哪', '位置', '怎么走'],
      reply: '具体工作地址请查看职位详情，如有疑问可进一步沟通。',
      matchMode: 'fuzzy',
    },
    {
      id: '4',
      keywords: ['上班时间', '工作时间', '几点上班'],
      reply: '工作时间请以职位描述为准，面试时可以详细了解。',
      matchMode: 'fuzzy',
    },
  ],
  fallbackReply: '感谢您的消息，我们已收到。稍后会有工作人员与您联系，请保持电话畅通。',
  delayMin: 3000,
  delayMax: 8000,
  hourlyLimit: 40,
  nightPauseStart: 0,  // 凌晨 0 点
  nightPauseEnd: 7,    // 早上 7 点
  logs: [],
};

// --- 限速状态（按 tabId 独立计数）---
// Map<tabId, { count, resetTime }>
const tabRateLimit = new Map();

// --- 简历详情缓存 ---
// Map<resumeid, detailObject>
const resumeDetailCache = new Map();

// --- 初始化 ---
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  // 只在首次安装时写入默认值
  if (!existing.rules) {
    await chrome.storage.local.set(DEFAULT_CONFIG);
    console.log('[58自动回复] 初始化默认配置');
  }
});

// --- 消息处理 ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'MATCH_REPLY') {
    handleMatchReply(msg).then(sendResponse);
    return true; // 异步响应
  }

  if (msg.type === 'LOG_REPLY') {
    logReply(msg);
    return false;
  }

  if (msg.type === 'RESUME_RECEIVED') {
    sendQQNotification(msg.candidate, msg.conversation);
    return false;
  }

  if (msg.type === 'WECHAT_RECEIVED') {
    sendWechatQQNotification(msg.candidate, msg.wechat, msg.grade, msg.conversation);
    return false;
  }

  if (msg.type === 'FETCH_RESUME_DETAIL') {
    openAndExtractResumeDetail(msg.url, msg.resumeid);
    return false;
  }

  if (msg.type === 'GET_STATUS') {
    getStatus().then(sendResponse);
    return true;
  }

  if (msg.type === 'CLEAR_LOGS') {
    chrome.storage.local.set({ logs: [] });
    return false;
  }
});

// --- 匹配回复 ---
async function handleMatchReply({ text, msgId, tabId = 'default' }) {
  const config = await chrome.storage.local.get({
    enabled: true,
    rules: [],
    fallbackReply: DEFAULT_CONFIG.fallbackReply,
    delayMin: DEFAULT_CONFIG.delayMin,
    delayMax: DEFAULT_CONFIG.delayMax,
    hourlyLimit: DEFAULT_CONFIG.hourlyLimit,
    nightPauseStart: DEFAULT_CONFIG.nightPauseStart,
    nightPauseEnd: DEFAULT_CONFIG.nightPauseEnd,
  });

  if (!config.enabled) {
    return { reply: null, reason: 'disabled' };
  }

  // 凌晨暂停
  const hour = new Date().getHours();
  if (hour >= config.nightPauseStart && hour < config.nightPauseEnd) {
    return { reply: null, reason: 'night_pause' };
  }

  // 限速检查（每个 tabId 独立计数，多账号互不影响）
  const now = Date.now();
  if (!tabRateLimit.has(tabId)) {
    tabRateLimit.set(tabId, { count: 0, resetTime: now + 3600000 });
  }
  const rate = tabRateLimit.get(tabId);
  if (now > rate.resetTime) {
    rate.count = 0;
    rate.resetTime = now + 3600000;
  }
  if (rate.count >= config.hourlyLimit) {
    return { reply: null, reason: 'rate_limited' };
  }

  // 固定话术回复（不做关键词匹配）
  const reply = '我们是做AI技术、3D建模、动画特效、影视后期、动漫设计、UE5虚幻引擎、unity3D开发等技术岗位，为了沟通顺畅，希望能投简历或加微信具体详聊';

  // 随机延迟
  const delay = config.delayMin + Math.random() * (config.delayMax - config.delayMin);

  rate.count++;

  return { reply, delay: Math.round(delay) };
}

// --- 关键词匹配引擎 ---
function matchKeyword(text, rules) {
  const normalizedText = text.toLowerCase().trim();

  // 第一轮：精确匹配
  for (const rule of rules) {
    if (rule.matchMode === 'exact') {
      for (const kw of rule.keywords) {
        if (normalizedText === kw.toLowerCase().trim()) {
          return rule.reply;
        }
      }
    }
  }

  // 第二轮：模糊匹配（包含关键词）
  for (const rule of rules) {
    if (rule.matchMode === 'fuzzy' || !rule.matchMode) {
      for (const kw of rule.keywords) {
        if (normalizedText.includes(kw.toLowerCase().trim())) {
          return rule.reply;
        }
      }
    }
  }

  // 无匹配
  return null;
}

// --- 记录日志 ---
async function logReply({ originalText, replyText, success, timestamp, tabId }) {
  const { logs = [] } = await chrome.storage.local.get({ logs: [] });

  logs.unshift({
    originalText: originalText?.substring(0, 100),
    replyText: replyText?.substring(0, 100),
    success,
    timestamp,
    tabId: tabId || 'unknown',
  });

  // 只保留最近 200 条
  if (logs.length > 200) {
    logs.length = 200;
  }

  await chrome.storage.local.set({ logs });
}

// --- 发送 QQ 群通知 ---
async function sendQQNotification(candidate, conversation) {
  try {
    // 基本信息
    const info = [
      `👤 ${candidate.name}`,
      `📋 ${candidate.target}`,
      `🎓 ${[candidate.experience, candidate.education, candidate.age, candidate.jobStatus].filter(Boolean).join(' | ')}`,
      `📞 ${candidate.phone}`,
    ].join('\n');

    // 对话记录（只取文本消息，最多15条）
    const convLines = (conversation || [])
      .filter(m => m.type === 'text' && m.role !== 'system')
      .slice(-15)
      .map(m => `${m.role === 'me' ? '【我】' : '【求职者】'} ${m.text}`)
      .join('\n');

    const msg = `📩 【新简历通知】\n${info}\n\n💬 对话记录：\n${convLines || '（无）'}`;

    await fetch(QQ_CONFIG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: QQ_CONFIG.groupId, message: msg }),
    });

    console.log('[58自动回复] QQ 群通知已发送');
  } catch (err) {
    console.error('[58自动回复] QQ 群通知失败:', err.message);
  }
}

// --- 后台打开简历详情页，提取内容，关闭标签 ---
async function openAndExtractResumeDetail(url, resumeid) {
  let tabId = null;
  try {
    console.log(`[58自动回复] 打开简历详情页: ${url}`);
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;

    // 等待页面加载完成（含超时保护）
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('页面加载超时'));
      }, 20000);

      function listener(id, info) {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });

    // 额外等待 Vue 渲染
    await new Promise(r => setTimeout(r, 2500));

    // 在页面上下文执行提取脚本
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractResumeDetailFromPage,
    });

    if (result?.result) {
      resumeDetailCache.set(resumeid, result.result);
      console.log(`[58自动回复] 简历详情已缓存 (${resumeid}):`, result.result);
    }
  } catch (err) {
    console.error('[58自动回复] 简历详情提取失败:', err.message);
  } finally {
    if (tabId !== null) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

// 在简历详情页的页面上下文中执行（通过 executeScript 注入）
// 选择器已根据实际页面 class 确认
function extractResumeDetailFromPage() {
  // 去掉"展开"/"收起"独立行（按钮文字可能在头部或尾部）
  const clean = (t) => (t || '')
    .split('\n')
    .filter(line => !['展开', '收起'].includes(line.trim()))
    .join('\n')
    .trim();

  // 取单元素文字
  const get = (sel) => clean(document.querySelector(sel)?.innerText || '');

  // 取多个元素文字列表
  const getItems = (sel) =>
    [...document.querySelectorAll(sel)].map(el => clean(el.innerText)).filter(Boolean);

  // 姓名（base-info 太杂，单独取 .name）
  const basicInfo = get('.name') || get('.user-name') || '';

  // 求职意向：配对 expect-name + expect-value，过滤"近期投递"噪音
  const EXCLUDE_EXPECT_KEYS = ['近期投递'];
  const jobObjective = (() => {
    const pairs = [];
    document.querySelectorAll('.expect-item').forEach(item => {
      const k = item.querySelector('.expect-name, .expect-title')?.innerText?.trim() || '';
      const v = item.querySelector('.expect-value')?.innerText?.trim() || '';
      if (EXCLUDE_EXPECT_KEYS.includes(k)) return;
      if (k && v) pairs.push(`${k}: ${v}`);
      else if (v) pairs.push(v);
    });
    return pairs.join(' | ');
  })();

  // 工作经历：精确作用域到 .job-experience，避免混入教育经历
  const workItems = getItems('.job-experience .experience-item');
  const workExp = workItems.join('\n---\n');

  // 教育经历：精确作用域到 .edu-experience
  const eduItems = getItems('.edu-experience .experience-item');
  const eduExp = eduItems.join('\n---\n');

  // 技能优势：去掉"优势与期望"标题行
  const skills = (() => {
    const el = document.querySelector('.advantages-wraper');
    if (!el) return '';
    return clean(el.innerText.replace(/^优势与期望\s*/u, ''));
  })();

  // 自我介绍
  const selfIntro = get('.self-introduce');

  // 兜底：页面正文（去掉多余空白，截取前 1500 字）
  const fallback = document.body?.innerText?.replace(/\s+/g, ' ').trim().substring(0, 1500) || '';

  return { basicInfo, jobObjective, workExp, eduExp, skills, selfIntro, fallback };
}

// --- 发送换微信结果 QQ 通知 ---
async function sendWechatQQNotification(candidate, wechat, grade, conversation) {
  try {
    // 等待简历详情（最多 8 秒，通常在 WeChat 交换期间已经加载完毕）
    const resumeid = candidate.resumeid || '';
    if (resumeid && !resumeDetailCache.has(resumeid)) {
      await new Promise(r => setTimeout(r, 8000));
    }

    const info = [
      `👤 ${candidate.name || '（未知）'}`,
      `📋 ${candidate.target || ''}`,
      `🎓 ${[candidate.experience, candidate.education, candidate.age, candidate.jobStatus].filter(Boolean).join(' | ')}`,
      `📞 ${candidate.phone || ''}`,
      `📱 微信号: ${wechat || '（未收到）'}`,
      `⭐ 评级: ${grade}`,
    ].filter(Boolean).join('\n');

    const convLines = (conversation || [])
      .filter(m => m.type === 'text' && m.role !== 'system')
      .slice(-10)
      .map(m => `${m.role === 'me' ? '【我】' : '【求职者】'} ${m.text}`)
      .join('\n');

    // 拼接详细简历
    let detailSection = '';
    const detail = resumeid ? resumeDetailCache.get(resumeid) : null;
    if (detail) {
      const parts = [];
      if (detail.basicInfo)    parts.push(`📌 基本信息\n${detail.basicInfo}`);
      if (detail.jobObjective) parts.push(`🎯 求职意向\n${detail.jobObjective}`);
      if (detail.workExp)      parts.push(`💼 工作经历\n${detail.workExp}`);
      if (detail.eduExp)       parts.push(`🎓 教育经历\n${detail.eduExp}`);
      if (detail.skills)       parts.push(`🔧 技能优势\n${detail.skills}`);
      if (detail.selfIntro)    parts.push(`📝 自我介绍\n${detail.selfIntro}`);
      // 如果结构化字段都空了，用兜底全文（截短）
      if (!parts.length && detail.fallback) {
        parts.push(`📄 简历正文（截取）\n${detail.fallback.substring(0, 800)}`);
      }
      if (parts.length) {
        detailSection = '\n\n━━━ 详细简历 ━━━\n' + parts.join('\n\n');
      }
      // 用完即清，防止缓存膨胀
      resumeDetailCache.delete(resumeid);
    }

    const msg = `🎯 【换微信通知 · ${grade}】\n${info}\n\n💬 对话记录\n${convLines || '（无）'}${detailSection}`;

    await fetch(QQ_CONFIG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: QQ_CONFIG.groupId, message: msg }),
    });

    console.log(`[58自动回复] QQ 换微信通知已发送 (${grade})`);
  } catch (err) {
    console.error('[58自动回复] QQ 换微信通知失败:', err.message);
  }
}

// --- 获取状态 ---
async function getStatus() {
  const config = await chrome.storage.local.get({
    enabled: true,
    logs: [],
    hourlyLimit: DEFAULT_CONFIG.hourlyLimit,
  });

  // 汇总所有账号的计数
  const tabStats = [...tabRateLimit.entries()].map(([tabId, rate]) => ({
    tabId,
    count: rate.count,
    limit: config.hourlyLimit,
  }));

  return {
    enabled: config.enabled,
    tabStats,
    hourlyLimit: config.hourlyLimit,
    recentLogs: (config.logs || []).slice(0, 20),
  };
}
