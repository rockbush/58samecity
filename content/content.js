// =============================================================================
// 58微聊自动回复 - Content Script
// 注入到 employer.58.com/main/imListPage
// =============================================================================

// --- DOM 选择器常量（58前端改版时只需修改此处）---
const SELECTORS = {
  // 聊天窗口
  chatWinBody: '.chat-win-body',
  msgOther: '.im-msg-other',
  msgMain: '.msg-text',
  msgTip: '.im-msg-tip',
  editor: '#im-editor',
  sendBtn: '.input-editor-footer .el-button--primary',
  chatWin: '#chat-win',

  // 简历卡片（已确认）
  resumeMsg: '.im-msg-resume-receive',
  resumeCard: '.card-receive-resume',
  resumeName: '.card-receive-resume .name',
  resumeTarget: '.card-receive-resume .target',
  resumeDesc: '.card-receive-resume .desc-wraper',
  resumePhoneBtn: '.mobile-btn', // 电话号码元素（在 .im-msg-resume-receive 内，不一定在 .card-receive-resume 内）

  // 左侧会话列表
  sessionList: '.mmc-session',
  sessionItem: '.session-item',                        // 单个会话条目（已确认）
  sessionUnreadBadge: '.unread',                                   // 未读数量（已确认）
  sessionActive: '.session-item.active',               // 当前激活的会话
  sessionName: '.name',                                // 会话名称（已确认）

  // 顶部 tab
  tabUnread: '.im-menu-item',                          // "未读" tab

  // 换微信功能
  wechatCard: '.im-msg-changeWx',                      // 换微信卡片（申请 or 成功，同一类名）
  wechatInviteBtns: '.changeWx-btns',                  // 对方主动申请换微信时的按钮容器
  wechatDesc: '.changeWx-desc',                        // 包含"我的微信号：xxx"的文字元素
  wechatDialogConfirm: '.ChangeWxConfim .el-button--primary', // 换微信确认弹窗确认按钮
};

// --- 状态 ---
const processedMsgIds = new Set();
const processedElements = new WeakSet(); // 用元素引用去重，防止 Vue 分批渲染触发两次
const processedWechatCards = new WeakSet();  // 防止重复处理换微信卡片（成功卡）
const processedWechatInvites = new WeakSet(); // 防止重复处理换微信申请
const lastRepliedMsgId = new Map();
const pendingExchanges = new Map(); // sessionId → { candidate, resumeTimestamp }
let observer = null;
let enabled = true;
let sendQueue = [];
let isSending = false;
let isScanning = false;          // 是否正在扫描未读会话
let scanTimer = null;

// --- 版本 ---
const VERSION = '1.18';

// --- 配置 ---
const SCAN_INTERVAL = 5000;      // 扫描未读会话的间隔（ms）
const SWITCH_WAIT = 2000;        // 切换会话后等待 DOM 加载的时间（ms）
const BETWEEN_SESSION_DELAY = 3000; // 处理完一个会话后等待的时间（ms）

// 当前标签页的唯一标识（用于独立限速和日志区分）
const TAB_ID = Math.random().toString(36).slice(2, 8);

// --- 初始化 ---
async function init() {
  const config = await chrome.storage.local.get({ enabled: true });
  enabled = config.enabled;

  await loadGreetedVisitors();
  await loadPendingExchanges();
  startGradeBChecker();

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      console.log('[58自动回复] 状态:', enabled ? '开启' : '关闭');
      if (enabled) {
        startSessionScanner();
        startVisitorScanner();
      } else {
        stopSessionScanner();
        stopVisitorScanner();
      }
    }
  });

  // 监听来自 service worker 的消息
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PING') {
      return true;
    }
  });

  // 等待聊天区域加载后，同时启动消息监听和会话扫描
  waitForChatBody();
  startSessionScanner();
  startVisitorScanner();
}

// --- 等待聊天区域 DOM 加载 ---
function waitForChatBody() {
  const chatBody = document.querySelector(SELECTORS.chatWinBody);
  if (chatBody) {
    startObserving(chatBody);
    return;
  }

  const bodyObserver = new MutationObserver(() => {
    const chatBody = document.querySelector(SELECTORS.chatWinBody);
    if (chatBody) {
      bodyObserver.disconnect();
      startObserving(chatBody);
    }
  });

  bodyObserver.observe(document.body, { childList: true, subtree: true });
  console.log('[58自动回复] 等待聊天窗口加载...');
}

// --- 开始监听当前会话的消息 ---
function startObserving(chatBody) {
  console.log('[58自动回复] 开始监听消息');

  // 如果之前有 observer 先断开
  if (observer) observer.disconnect();

  observer = new MutationObserver((mutations) => {
    if (!enabled) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        processNode(node);
      }
    }
  });

  observer.observe(chatBody, { childList: true, subtree: true });
  markExistingMessages(chatBody);
}

// --- 标记已有消息，防止重复回复 ---
function markExistingMessages(container) {
  const existingMsgs = container.querySelectorAll(SELECTORS.msgOther);
  for (const msg of existingMsgs) {
    const msgId = getMsgId(msg);
    if (msgId) {
      processedMsgIds.add(msgId);
    }
  }
  console.log(`[58自动回复] 标记 ${existingMsgs.length} 条已有消息`);
}

// =============================================================================
// 会话扫描器 — 自动发现并切换未读会话
// =============================================================================

function startSessionScanner() {
  if (scanTimer) return;
  console.log('[58自动回复] 启动未读会话扫描器');
  scanTimer = setInterval(() => {
    if (enabled && !isScanning && !isSending) {
      scanUnreadSessions();
    }
  }, SCAN_INTERVAL);
}

function stopSessionScanner() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
    console.log('[58自动回复] 停止未读会话扫描器');
  }
}

async function scanUnreadSessions() {
  isScanning = true;

  try {
    const unreadItems = findUnreadSessions();
    if (unreadItems.length === 0) {
      return;
    }

    console.log(`[58自动回复] 发现 ${unreadItems.length} 个未读会话`);

    for (const item of unreadItems) {
      if (!enabled) break;

      // 等发送队列清空
      while (isSending) {
        await sleep(1000);
      }

      const sessionId = getSessionId(item);
      const sessionName = getSessionName(item);

      console.log(`[58自动回复] 切换到会话: ${sessionName || sessionId}`);

      // 点击切换会话
      item.click();
      await sleep(SWITCH_WAIT);

      // 重新绑定 observer 到新的聊天窗口
      const chatBody = document.querySelector(SELECTORS.chatWinBody);
      if (chatBody) {
        // 先标记已有消息，再获取最后一条对方消息
        markExistingMessages(chatBody);

        // 获取当前会话中最后一条对方消息并处理
        await handleLastMessageInSession(chatBody, sessionId);
      }

      // 等待回复发送完成
      while (isSending || sendQueue.length > 0) {
        await sleep(1000);
      }

      // 会话间间隔
      await sleep(BETWEEN_SESSION_DELAY);
    }

    // 额外扫描有待处理换微信的会话（即使没有未读角标，微信卡片可能已被浏览过）
    for (const [pendingSessionId] of pendingExchanges.entries()) {
      if (!enabled) break;

      let targetItem = null;
      for (const item of document.querySelectorAll(SELECTORS.sessionItem)) {
        if (getSessionId(item) === pendingSessionId) { targetItem = item; break; }
      }
      if (!targetItem) continue;

      targetItem.click();
      await sleep(SWITCH_WAIT);

      const chatBody = document.querySelector(SELECTORS.chatWinBody);
      if (chatBody) {
        const cards = chatBody.querySelectorAll(SELECTORS.wechatCard);
        for (const card of cards) {
          if (!processedWechatCards.has(card)) {
            await handleWechatCard(card);
          }
        }
      }

      await sleep(BETWEEN_SESSION_DELAY);
    }
  } catch (err) {
    console.error('[58自动回复] 扫描未读会话出错:', err);
  } finally {
    isScanning = false;
  }
}

// --- 查找所有未读会话 ---
function findUnreadSessions() {
  const items = document.querySelectorAll(SELECTORS.sessionItem);
  const unreadItems = [];

  for (const item of items) {
    if (isSessionUnread(item)) {
      unreadItems.push(item);
    }
  }

  return unreadItems;
}

// --- 判断会话是否有未读消息 ---
function isSessionUnread(sessionItem) {
  // .unread 内有正整数即为未读（已确认的 DOM 结构）
  const badge = sessionItem.querySelector(SELECTORS.sessionUnreadBadge);
  if (!badge) return false;
  const count = parseInt(badge.textContent.trim());
  return Number.isFinite(count) && count > 0;
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

// --- 获取会话标识 ---
function getSessionId(sessionItem) {
  return sessionItem.getAttribute('data-key') ||   // 已确认
         sessionItem.getAttribute('data-id') ||
         sessionItem.dataset?.sessionId ||
         simpleHash(sessionItem.innerText);
}

function getSessionName(sessionItem) {
  const nameEl = sessionItem.querySelector(SELECTORS.sessionName);
  if (nameEl) return nameEl.textContent.trim();
  // 降级：取第一行文字
  const text = sessionItem.innerText?.trim();
  return text ? text.split('\n')[0].substring(0, 20) : '';
}

// --- 处理当前会话中的未读消息 ---
async function handleLastMessageInSession(chatBody, sessionId) {
  const allMsgs = [...chatBody.querySelectorAll('.im-msg')];
  if (allMsgs.length === 0) return;

  // 找到最后一条「我方消息」的位置
  let lastMyMsgIndex = -1;
  for (let i = allMsgs.length - 1; i >= 0; i--) {
    if (allMsgs[i].classList.contains('im-msg-me')) {
      lastMyMsgIndex = i;
      break;
    }
  }

  // 收集最后一条我方消息之后、对方发来的所有消息（排除简历卡片，由 handleResumeCard 单独处理）
  const unreadOtherMsgs = allMsgs
    .slice(lastMyMsgIndex + 1)
    .filter(el => el.classList.contains('im-msg-other') && !el.classList.contains('im-msg-resume-receive'));

  if (unreadOtherMsgs.length === 0) {
    console.log(`[58自动回复] 会话 ${sessionId} 无未回复文本消息，跳过`);
    return;
  }

  // 用「未回复消息数量 + 最后一条消息文本」组合生成本轮标识
  // 对方发了新消息时，数量或文本至少有一个会变化
  const lastUnreadMsg = unreadOtherMsgs[unreadOtherMsgs.length - 1];
  const lastUnreadId = simpleHash(
    String(unreadOtherMsgs.length) + '_' + (extractText(lastUnreadMsg) || '')
  );

  // 与上次回复时的标识对比，相同则跳过
  if (lastRepliedMsgId.get(sessionId) === lastUnreadId) {
    console.log(`[58自动回复] 会话 ${sessionId} 对方无新消息，跳过`);
    return;
  }

  // 把对方连续发来的多条消息合并为一段文本，只回复一次
  const combinedText = unreadOtherMsgs
    .map(el => extractText(el))
    .filter(Boolean)
    .join(' ');

  if (!combinedText) return;

  console.log(`[58自动回复] 会话 ${sessionId} 未回复消息（${unreadOtherMsgs.length}条）: "${combinedText}"`);

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'MATCH_REPLY', text: combinedText, msgId: lastUnreadId, tabId: TAB_ID },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[58自动回复] 通信错误:', chrome.runtime.lastError.message);
          resolve();
          return;
        }
        if (response?.reply) {
          lastRepliedMsgId.set(sessionId, lastUnreadId);
          enqueueSend(response.reply, response.delay, combinedText);
        } else {
          // 无匹配回复时也记录，避免兜底回复也反复触发
          lastRepliedMsgId.set(sessionId, lastUnreadId);
        }
        resolve();
      }
    );
  });
}

// =============================================================================
// 消息处理（当前打开的会话内，实时监听新消息）
// =============================================================================

function processNode(node) {
  // 换微信卡片（对方同意后发来，优先处理）
  if (node.matches?.(SELECTORS.wechatCard)) {
    handleWechatCard(node);
    return;
  }

  // 简历卡片消息（优先判断）
  if (node.matches?.(SELECTORS.resumeMsg)) {
    handleResumeCard(node);
    return;
  }

  if (node.matches?.(SELECTORS.msgOther)) {
    handleNewMessage(node);
    return;
  }

  // 子树里查找
  const wechatCards = node.querySelectorAll?.(SELECTORS.wechatCard);
  if (wechatCards) {
    for (const card of wechatCards) handleWechatCard(card);
  }

  const resumeMsgs = node.querySelectorAll?.(SELECTORS.resumeMsg);
  if (resumeMsgs) {
    for (const msg of resumeMsgs) handleResumeCard(msg);
  }

  const msgs = node.querySelectorAll?.(SELECTORS.msgOther);
  if (msgs) {
    for (const msg of msgs) handleNewMessage(msg);
  }
}

function getMsgId(msgEl) {
  // data-msgid 在内部的 .im-msg-content 元素上（已确认）
  const inner = msgEl.querySelector('[data-msgid]');
  if (inner) return inner.getAttribute('data-msgid');
  // 兜底：用文本内容哈希
  return simpleHash(extractText(msgEl) || '');
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return 'h_' + Math.abs(hash).toString(36);
}

function extractText(msgEl) {
  if (msgEl.matches?.(SELECTORS.msgTip)) return null;

  const mainEl = msgEl.querySelector(SELECTORS.msgMain);
  const target = mainEl || msgEl;

  const text = target.innerText?.trim();
  return text || null;
}

// 已启动电话监听的卡片（避免重复绑定 observer）
const resumePhoneWatching = new WeakSet();

// --- 等待电话写入：对 phoneEl 绑定专属 observer，用 expectedName 防止 Vue 复用错乱 ---
function waitForPhone(msgEl, expectedName, phoneEl) {
  if (resumePhoneWatching.has(msgEl)) return;
  resumePhoneWatching.add(msgEl);

  const tryProcess = () => {
    if (processedElements.has(msgEl)) return; // 已处理，放弃
    const currentName = msgEl.querySelector(SELECTORS.resumeName)?.innerText.trim() || '';
    if (currentName !== expectedName) {
      // Vue 复用了这个元素渲染别人，放弃
      console.log(`[58自动回复] 卡片元素被复用（${expectedName}→${currentName}），放弃等待`);
      watcher.disconnect();
      return;
    }
    const phone = phoneEl.innerText.trim();
    if (/^1[3-9]\d{9}$/.test(phone)) {
      watcher.disconnect();
      doProcessResumeCard(msgEl, expectedName, phone, apiResumeCache.get(expectedName) || null);
    }
  };

  const watcher = new MutationObserver(tryProcess);
  watcher.observe(phoneEl, { childList: true, characterData: true, subtree: true });

  // 最多等 5 秒
  setTimeout(() => {
    watcher.disconnect();
    if (!processedElements.has(msgEl)) {
      console.warn(`[58自动回复] 等待 ${expectedName} 电话超时，跳过`);
    }
  }, 5000);
}

// --- 处理简历卡片入口 ---
function handleResumeCard(msgEl) {
  if (processedElements.has(msgEl)) return;

  const name = msgEl.querySelector(SELECTORS.resumeName)?.innerText.trim() || '';
  if (!name) return;

  // 优先用 API 缓存的电话（最可靠，不受 DOM 复用影响）
  const cached = apiResumeCache.get(name);
  if (cached?.phone) {
    doProcessResumeCard(msgEl, name, cached.phone, cached);
    return;
  }

  // API 数据还没到，等 DOM 里的电话元素
  const phoneEl = msgEl.querySelector(SELECTORS.resumePhoneBtn);
  const phone   = phoneEl?.innerText.trim() || '';

  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
    if (phoneEl) waitForPhone(msgEl, name, phoneEl);
    return;
  }

  doProcessResumeCard(msgEl, name, phone, null);
}

// --- 简历卡片核心处理（name/phone 均已确认有效时调用）---
// msgEl 可为 null（API 驱动时无 DOM 元素）
// directMsgId：API 直接提供的 msgId，优先于 DOM 解析
function doProcessResumeCard(msgEl, name, phone, apiData, directMsgId = null) {
  // 元素级去重（DOM 驱动时）
  if (msgEl && processedElements.has(msgEl)) return;

  // 消息 ID 级去重（API 和 DOM 共用）
  const msgId = directMsgId || getMsgId(msgEl) || '';
  if (msgId && processedMsgIds.has(msgId)) return;
  if (msgId) processedMsgIds.add(msgId);
  if (msgEl) processedElements.add(msgEl);

  // 优先用 API 数据，退回 DOM 解析
  let target, experience, education, age, jobStatus;
  if (apiData) {
    target     = apiData.applyjob  || '';
    experience = apiData.experience || '';
    education  = apiData.educational || '';
    age        = apiData.age        || '';
    jobStatus  = apiData.jobState   || '';
  } else {
    target = msgEl.querySelector(SELECTORS.resumeTarget)?.innerText.trim().replace('投递职位-', '') || '';
    const desc = msgEl.querySelector(SELECTORS.resumeDesc)?.innerText.trim() || '';
    [experience = '', education = '', age = '', jobStatus = ''] = desc.split(/[｜|]/);
    experience = experience.trim(); education = education.trim();
    age = age.trim(); jobStatus = jobStatus.trim();
  }

  const candidate = {
    name,
    target,
    experience: experience.trim(),
    education: education.trim(),
    age: age.trim(),
    jobStatus: jobStatus.trim(),
    phone,
    resumeid: apiData?.resumeid || '',
    timestamp: Date.now(),
  };

  console.log('[58自动回复] 收到简历:', candidate);

  // 抓取当前完整对话记录
  const conversation = captureConversation();

  // 存入 chrome.storage + 年龄过滤 + 发 QQ 通知 + 自动回复
  chrome.storage.local.get({
    candidates: [],
    visitorIgnoreAge: false,
    visitorAgeMin: 20,
    visitorAgeMax: 30,
  }, ({ candidates, visitorIgnoreAge, visitorAgeMin, visitorAgeMax }) => {
    const exists = candidates.some(c => c.msgId === msgId);
    if (!exists) {
      candidates.unshift({ ...candidate, msgId, conversation });
      if (candidates.length > 1000) candidates.length = 1000;
      chrome.storage.local.set({ candidates });

      // 年龄过滤：简历卡片里的年龄是纯文本，可靠
      const ageNum = parseInt(candidate.age);
      if (!visitorIgnoreAge && !isNaN(ageNum) && (ageNum < visitorAgeMin || ageNum > visitorAgeMax)) {
        console.log(`[58自动回复] 简历年龄 ${ageNum} 不在 ${visitorAgeMin}-${visitorAgeMax}，不回复也不通知QQ`);
        return;
      }

      // 抓取简历详情页（后台静默打开）
      const resumeDetailUrl = getResumeDetailUrl(msgEl, candidate.resumeid);
      if (resumeDetailUrl) {
        chrome.runtime.sendMessage({
          type: 'FETCH_RESUME_DETAIL',
          url: resumeDetailUrl,
          resumeid: candidate.resumeid || simpleHash(name + phone),
        });
      }

      // 自动回复求职者（换微信话术）
      enqueueSend('已收到你的简历，为了更好的沟通，我们交换个微信吧', 3000, '简历投递');

      // 记录待处理换微信，并在回复发送后点击换微信按钮
      // 查找会话 ID：优先当前激活会话，退回用 API 的 chatUserId 匹配 data-key
      let sessionId = getCurrentSessionId();
      if (!sessionId && apiData?.chatUserId) {
        for (const item of document.querySelectorAll(SELECTORS.sessionItem)) {
          const key = getSessionId(item);
          if (key === apiData.chatUserId || key === apiData.chatUserId + '@2') {
            sessionId = key;
            break;
          }
        }
        if (sessionId) console.log('[58自动回复] 通过 chatUserId 找到会话:', sessionId);
      }
      if (sessionId) {
        pendingExchanges.set(sessionId, { candidate, resumeTimestamp: candidate.timestamp });
        savePendingExchange();
        setTimeout(() => initiateWechatExchange(sessionId), 5000); // 等回复发送完毕
      } else {
        console.warn('[58自动回复] 无法确定会话 ID，换微信流程跳过');
      }
    }
  });
}

// --- 抓取当前聊天窗口的完整对话 ---
function captureConversation() {
  const chatBody = document.querySelector(SELECTORS.chatWinBody);
  if (!chatBody) return [];

  const messages = [];

  chatBody.querySelectorAll('.im-msg').forEach(el => {
    // 跳过系统提示
    if (el.classList.contains('im-msg-tip')) {
      const tipText = el.innerText?.trim();
      if (tipText) messages.push({ role: 'system', text: tipText });
      return;
    }

    const isMe = el.classList.contains('im-msg-me');
    const isOther = el.classList.contains('im-msg-other');
    if (!isMe && !isOther) return;

    // 简历卡片消息单独标注
    if (el.classList.contains('im-msg-resume-receive')) {
      const name   = el.querySelector(SELECTORS.resumeName)?.innerText.trim() || '';
      const target = el.querySelector(SELECTORS.resumeTarget)?.innerText.trim() || '';
      const desc   = el.querySelector(SELECTORS.resumeDesc)?.innerText.trim() || '';
      const phone  = el.querySelector(SELECTORS.resumePhone)?.innerText.trim() || '';
      messages.push({
        role: 'other',
        type: 'resume',
        text: `[简历卡片] ${name} ${target} ${desc} ${phone}`.trim(),
      });
      return;
    }

    // 普通文本消息
    const text = el.querySelector(SELECTORS.msgMain)?.innerText.trim()
              || el.querySelector('.im-msg-content')?.innerText.trim()
              || '';
    const time = el.querySelector('.im-msg-time')?.innerText.trim() || '';

    if (text) {
      messages.push({
        role: isMe ? 'me' : 'other',
        type: 'text',
        text,
        time,
      });
    }
  });

  return messages;
}

function handleNewMessage(msgEl) {
  const msgId = getMsgId(msgEl);
  if (!msgId || processedMsgIds.has(msgId)) return;
  processedMsgIds.add(msgId);

  const text = extractText(msgEl);
  if (!text) return;

  // 如果正在扫描会话，跳过实时监听（避免冲突）
  if (isScanning) return;

  console.log(`[58自动回复] 收到实时消息: "${text}"`);

  chrome.runtime.sendMessage(
    { type: 'MATCH_REPLY', text, msgId },
    (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[58自动回复] 通信错误:', chrome.runtime.lastError.message);
        return;
      }
      if (response?.reply) {
        enqueueSend(response.reply, response.delay, text);
      }
    }
  );
}

// =============================================================================
// 发送消息
// =============================================================================

function enqueueSend(replyText, delayMs, originalText) {
  sendQueue.push({ replyText, delayMs, originalText });
  processSendQueue();
}

async function processSendQueue() {
  if (isSending || sendQueue.length === 0) return;
  isSending = true;

  const { replyText, delayMs, originalText } = sendQueue.shift();

  console.log(`[58自动回复] ${delayMs}ms 后回复: "${replyText}"`);

  await sleep(delayMs);
  const success = await sendReply(replyText);

  chrome.runtime.sendMessage({
    type: 'LOG_REPLY',
    originalText,
    replyText,
    success,
    timestamp: Date.now(),
    tabId: TAB_ID,
  });

  isSending = false;
  processSendQueue();
}

async function sendReply(text) {
  try {
    const editor = document.querySelector(SELECTORS.editor);
    if (!editor) {
      console.error('[58自动回复] 找不到输入框');
      return false;
    }

    editor.focus();
    await sleep(100);

    // 清空已有内容
    editor.innerHTML = '';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(50);

    // 使用 execCommand 插入文本
    document.execCommand('insertText', false, text);
    await sleep(100);

    // 触发事件确保 Vue 响应
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);

    // 点击发送
    const sendBtn = document.querySelector(SELECTORS.sendBtn);
    if (!sendBtn) {
      console.error('[58自动回复] 找不到发送按钮');
      return false;
    }

    sendBtn.click();
    console.log('[58自动回复] 消息已发送');
    return true;
  } catch (err) {
    console.error('[58自动回复] 发送失败:', err);
    return false;
  }
}

// =============================================================================
// 工具函数
// =============================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 定期清理 processedMsgIds 防止内存泄漏
setInterval(() => {
  if (processedMsgIds.size > 5000) {
    const arr = [...processedMsgIds];
    const toRemove = arr.slice(0, arr.length - 1000);
    for (const id of toRemove) processedMsgIds.delete(id);
    console.log(`[58自动回复] 清理 ${toRemove.length} 条历史消息ID`);
  }
}, 5 * 60 * 1000);

// 定期清理 lastRepliedMsgId（超过1000个会话时清理最老的一半）
setInterval(() => {
  if (lastRepliedMsgId.size > 1000) {
    const keys = [...lastRepliedMsgId.keys()];
    keys.slice(0, 500).forEach(k => lastRepliedMsgId.delete(k));
    console.log('[58自动回复] 清理已回复会话记录');
  }
}, 2 * 60 * 60 * 1000);

// =============================================================================
// 版本 2：访客主动打招呼 + 年龄解码（PUA 字体宽度法）
// =============================================================================

// --- 简历 API 缓存（intercept.js 从 get_chat_records 拦截到的真实数据）---
// key: name（姓名），value: { resumeid, name, phone, age, educational, experience, applyjob, jobState }
const apiResumeCache = new Map();

window.addEventListener('message', (e) => {
  if (e.data?.type === '_58_RESUME' && e.data.name && e.data.phone) {
    const data = e.data;
    apiResumeCache.set(data.name, data);
    console.log(`[58自动回复] API拦截到简历: ${data.name} → ${data.phone}`);

    // API 数据即判定对方发了简历，直接触发处理（不等 DOM 渲染）
    if (enabled) {
      doProcessResumeCard(null, data.name, data.phone, data, data.msgId || '');
    }
  }
});

// --- 访客状态 ---
const greetedVisitors = new Set();      // 已打招呼的访客 ID（内存）
let visitorScanTimer = null;

// --- 加载/保存已打招呼记录（跨刷新持久化）---
async function loadGreetedVisitors() {
  const { greetedVisitorIds = [] } = await chrome.storage.local.get({ greetedVisitorIds: [] });
  greetedVisitorIds.forEach(id => greetedVisitors.add(id));
  console.log(`[58自动回复] 已加载 ${greetedVisitors.size} 个已打招呼访客`);
}

async function saveGreetedVisitor(id) {
  greetedVisitors.add(id);
  const { greetedVisitorIds = [] } = await chrome.storage.local.get({ greetedVisitorIds: [] });
  if (!greetedVisitorIds.includes(id)) {
    greetedVisitorIds.push(id);
    if (greetedVisitorIds.length > 5000) greetedVisitorIds.splice(0, greetedVisitorIds.length - 5000);
    await chrome.storage.local.set({ greetedVisitorIds });
  }
}

// --- 访客扫描器 ---
function startVisitorScanner() {
  if (visitorScanTimer) return;
  console.log('[58自动回复] 启动访客扫描器');
  // 用 setTimeout ID 占位，防止重复启动；10 秒后换成 setInterval
  visitorScanTimer = setTimeout(() => {
    scanNewVisitors();
    visitorScanTimer = setInterval(scanNewVisitors, 30000);
  }, 10000);
}

function stopVisitorScanner() {
  if (visitorScanTimer) {
    clearInterval(visitorScanTimer);
    visitorScanTimer = null;
    console.log('[58自动回复] 停止访客扫描器');
  }
}

async function scanNewVisitors() {
  if (!enabled || isScanning) return;

  const { visitorGreetingEnabled } = await chrome.storage.local.get({ visitorGreetingEnabled: true });
  if (!visitorGreetingEnabled) return;

  const visitorTab = findTabByText('我的访客');
  if (!visitorTab) {
    console.log('[58自动回复] 未找到"我的访客"tab');
    return;
  }

  // 导航到访客列表，收集待处理的访客 ID
  visitorTab.click();
  await sleep(1500);

  const pendingIds = [];
  for (const v of document.querySelectorAll('.infocardLi')) {
    const id = v.getAttribute('resumeid') || v.getAttribute('infoid') || v.getAttribute('cuid');
    if (id && !greetedVisitors.has(id)) pendingIds.push(id);
  }

  if (!pendingIds.length) {
    console.log('[58自动回复] 无新访客需要处理');
    return;
  }

  console.log(`[58自动回复] 发现 ${pendingIds.length} 名新访客`);

  for (const visitorId of pendingIds) {
    if (!enabled) break;

    // 每次处理前重新回到访客列表，避免上次导航残留
    visitorTab.click();
    await sleep(1500);

    const visitor = findVisitorById(visitorId);
    if (!visitor) continue;

    // 若卡片已标记「已沟通」，说明已主动联系过，跳过
    if (visitor.textContent.includes('已沟通')) {
      console.log(`[58自动回复] 访客 ${visitorId} 已沟通，标记跳过`);
      await saveGreetedVisitor(visitorId);
      continue;
    }

    // 点击访客卡片，等右侧面板加载
    visitor.click();
    await sleep(1200);

    // 等待右侧面板的「在线沟通」按钮出现（最多 6 秒）
    const btn = await waitForExactButton(['在线沟通'], 6000);
    if (!btn) {
      console.log('[58自动回复] 未找到「在线沟通」按钮（6秒超时），跳过');
      continue;
    }

    btn.click();
    console.log(`[58自动回复] 已点击「在线沟通」，访客 ${visitorId}`);
    await saveGreetedVisitor(visitorId);
    await sleep(2000);
  }

  // 扫描结束后回到消息列表
  findTabByText('我的消息')?.click();
}

// --- 辅助：按文字找 tab ---
function findTabByText(text) {
  const candidates = document.querySelectorAll(
    '.im-menu-item, [class*="tab-item"], [class*="menu-item"], [class*="nav-item"]'
  );
  for (const el of candidates) {
    if (el.textContent.trim().includes(text)) return el;
  }
  return null;
}

// --- 辅助：轮询等待按钮出现 ---
async function waitForExactButton(texts, maxWaitMs = 5000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const btn = findExactButton(texts);
    if (btn) return btn;
    await sleep(500);
  }
  return null;
}

// --- 辅助：精确匹配按钮文字（遍历所有元素，不依赖 class/tag）---
// 不做 isVisible 检查：CSS 过渡动画期间 opacity/visibility 可能未稳定，会漏检
function findExactButton(texts) {
  let fallback = null;
  for (const el of document.body.querySelectorAll('*')) {
    const t = el.textContent.trim();
    if (!texts.includes(t)) continue;
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return el;
    if (!fallback) fallback = el;
  }
  return fallback;
}

// --- 辅助：按 ID 在访客列表中找元素 ---
function findVisitorById(id) {
  for (const v of document.querySelectorAll('.infocardLi')) {
    const vid = v.getAttribute('resumeid') || v.getAttribute('infoid') || v.getAttribute('cuid');
    if (vid === id) return v;
  }
  return null;
}

// =============================================================================
// 版本 3：换微信流程
// =============================================================================

// --- 获取当前激活会话 ID ---
function getCurrentSessionId() {
  const active = document.querySelector(SELECTORS.sessionActive);
  return active ? getSessionId(active) : null;
}

// --- 找到"换微信"按钮（遍历聊天输入区叶节点）---
function findWechatBtn() {
  const inputArea = document.querySelector('.chat-win-input');
  if (inputArea) {
    for (const el of inputArea.querySelectorAll('*')) {
      if (el.children.length === 0 && el.textContent.trim() === '换微信') return el;
    }
  }
  // 兜底：全局查找
  for (const el of document.body.querySelectorAll('*')) {
    if (el.children.length === 0 && el.textContent.trim() === '换微信') return el;
  }
  return null;
}

async function waitForWechatBtn(maxWaitMs = 3000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const btn = findWechatBtn();
    if (btn) return btn;
    await sleep(300);
  }
  return null;
}

// --- 点击"换微信"并确认弹窗 ---
async function initiateWechatExchange(sessionId) {
  if (!pendingExchanges.has(sessionId)) return;

  // 确保目标会话是当前激活会话
  if (getCurrentSessionId() !== sessionId) {
    let targetItem = null;
    for (const item of document.querySelectorAll(SELECTORS.sessionItem)) {
      if (getSessionId(item) === sessionId) { targetItem = item; break; }
    }
    if (!targetItem) {
      console.log('[58自动回复] initiateWechatExchange: 找不到目标会话，跳过');
      return;
    }
    console.log('[58自动回复] 切换回目标会话后执行换微信');
    targetItem.click();
    await sleep(2000);
  }

  const btn = await waitForWechatBtn(4000);
  if (!btn) {
    console.log('[58自动回复] 未找到「换微信」按钮，跳过');
    return;
  }

  btn.click();
  console.log('[58自动回复] 已点击「换微信」');

  // 等待确认弹窗出现，并轮询直到确定按钮可用（最多 5s）
  await sleep(1000);
  let confirmBtn = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const candidate = document.querySelector(SELECTORS.wechatDialogConfirm)
      || document.querySelector('.exchangeWxModal .el-button--primary');
    if (candidate && !candidate.disabled && !candidate.classList.contains('is-disabled')) {
      confirmBtn = candidate;
      break;
    }
    await sleep(300);
  }

  if (confirmBtn) {
    confirmBtn.click();
    console.log('[58自动回复] 已确认换微信弹窗');
  } else {
    console.log('[58自动回复] 换微信确认按钮未出现或仍禁用，跳过');
  }
}

// --- 处理对方主动发来的换微信申请（有拒绝/同意按钮）---
function handleWechatInvite(cardEl) {
  if (processedWechatInvites.has(cardEl)) return;
  processedWechatInvites.add(cardEl);

  const btnsContainer = cardEl.querySelector(SELECTORS.wechatInviteBtns);
  if (!btnsContainer) return;

  let agreeBtn = null;
  for (const btn of btnsContainer.querySelectorAll('.el-button--primary')) {
    if (btn.textContent.trim() === '同意') { agreeBtn = btn; break; }
  }
  if (!agreeBtn) {
    console.log('[58自动回复] 换微信申请：未找到同意按钮');
    return;
  }

  const delay = 1500 + Math.random() * 2000;
  console.log(`[58自动回复] 检测到换微信申请，${Math.round(delay / 1000)}s 后自动同意`);
  setTimeout(() => {
    if (!agreeBtn.disabled && !agreeBtn.classList.contains('is-disabled')) {
      agreeBtn.click();
      console.log('[58自动回复] 已点击同意换微信申请');
    }
  }, delay);
}

// --- 处理对方发来的微信卡片 ---
async function handleWechatCard(cardEl) {
  // 先判断是申请卡（有 changeWx-btns）还是成功卡（有微信号）
  if (cardEl.querySelector(SELECTORS.wechatInviteBtns)) {
    handleWechatInvite(cardEl);
    return;
  }

  if (processedWechatCards.has(cardEl)) return;
  processedWechatCards.add(cardEl);

  const descEl = cardEl.querySelector(SELECTORS.wechatDesc);
  if (!descEl) {
    console.log('[58自动回复] 换微信卡片：未找到微信号描述元素');
    return;
  }

  const descText = descEl.innerText.trim();
  // "我的微信号：rockbush" → "rockbush"
  const wechat = descText.replace(/^我的微信号[：:]\s*/u, '').trim();
  if (!wechat) {
    console.log('[58自动回复] 换微信卡片：微信号为空');
    return;
  }

  console.log(`[58自动回复] 收到微信号: ${wechat}`);

  const sessionId = getCurrentSessionId();
  const pending = sessionId ? pendingExchanges.get(sessionId) : null;

  const now = Date.now();
  const elapsed = pending ? now - pending.resumeTimestamp : Infinity;
  const grade = elapsed < 10 * 60 * 1000 ? 'A量' : 'B量';
  const candidate = pending?.candidate || {};

  // 回复确认已收到
  enqueueSend('已收到微信，马上加你，注意通过一下哟', 1500, '微信卡片');

  // 发 QQ 通知
  chrome.runtime.sendMessage({
    type: 'WECHAT_RECEIVED',
    candidate,
    wechat,
    grade,
    conversation: captureConversation(),
  });

  // 清除待处理记录
  if (sessionId) {
    await removePendingExchange(sessionId);
  }
}

// --- 持久化 pendingExchanges ---
async function loadPendingExchanges() {
  const { pendingExchangesData = [] } = await chrome.storage.local.get({ pendingExchangesData: [] });
  for (const [sid, data] of pendingExchangesData) {
    pendingExchanges.set(sid, data);
  }
  console.log(`[58自动回复] 已加载 ${pendingExchanges.size} 个待换微信记录`);
}

async function savePendingExchange() {
  const arr = [...pendingExchanges.entries()];
  await chrome.storage.local.set({ pendingExchangesData: arr });
}

async function removePendingExchange(sessionId) {
  pendingExchanges.delete(sessionId);
  await savePendingExchange();
}

// --- 定时检查 B 量超时（10 分钟未收到微信）---
function startGradeBChecker() {
  setInterval(async () => {
    const now = Date.now();
    const TIMEOUT = 10 * 60 * 1000;

    for (const [sessionId, data] of [...pendingExchanges.entries()]) {
      if (now - data.resumeTimestamp >= TIMEOUT) {
        console.log(`[58自动回复] 会话 ${sessionId} 超时未收到微信，发送B量通知`);
        chrome.runtime.sendMessage({
          type: 'WECHAT_RECEIVED',
          candidate: data.candidate,
          wechat: '',
          grade: 'B量',
          conversation: [],
        });
        await removePendingExchange(sessionId);
      }
    }
  }, 60000);
}

// --- 获取简历详情页 URL ---
// 优先从卡片内的 <a> 链接取，退而用 resumeid 构造
function getResumeDetailUrl(msgEl, resumeid) {
  // 卡片里可能有 <a> 直接带 href
  const link = msgEl.querySelector('a[href*="resume"]') || msgEl.querySelector('a[href]');
  if (link?.href) return link.href;

  // 用 resumeid 构造（58同城雇主端已确认的 URL 格式）
  if (resumeid) {
    return `https://employer.58.com/main/resumedetail?resumeid=${resumeid}`;
  }
  return null;
}

// --- 调试辅助：在扩展 content script 上下文的控制台可调用 ---
window._58findBtn = (keyword) => {
  const results = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (!isVisible(el)) continue;
    const t = el.textContent.trim();
    if (keyword ? t.includes(keyword) : t.length > 0 && t.length < 15) {
      results.push({ tag: el.tagName, text: t, class: el.className });
    }
  }
  return results;
};

// --- 启动 ---
init();
