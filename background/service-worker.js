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

  // 关键词匹配
  const reply = matchKeyword(text, config.rules) || config.fallbackReply;

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
async function logReply({ originalText, replyText, success, timestamp }) {
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
