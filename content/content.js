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
  resumePhone: '.card-receive-resume .mobile-btn',

  // 左侧会话列表
  sessionList: '.mmc-session',
  sessionItem: '.session-item',                        // 单个会话条目（已确认）
  sessionUnreadBadge: '.unread',                                   // 未读数量（已确认）
  sessionActive: '.session-item.active',               // 当前激活的会话
  sessionName: '.name',                                // 会话名称（已确认）

  // 顶部 tab
  tabUnread: '.im-menu-item',                          // "未读" tab
};

// --- 状态 ---
const processedMsgIds = new Set();
const processedElements = new WeakSet(); // 用元素引用去重，防止 Vue 分批渲染触发两次
const lastRepliedMsgId = new Map();
let observer = null;
let enabled = true;
let sendQueue = [];
let isSending = false;
let isScanning = false;          // 是否正在扫描未读会话
let scanTimer = null;

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

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      console.log('[58自动回复] 状态:', enabled ? '开启' : '关闭');
      if (enabled) {
        startSessionScanner();
      } else {
        stopSessionScanner();
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

// --- 处理简历卡片 ---
function handleResumeCard(msgEl) {
  // 用元素引用去重：Vue 分批渲染会多次触发，但元素是同一个对象
  if (processedElements.has(msgEl)) return;

  const name    = msgEl.querySelector(SELECTORS.resumeName)?.innerText.trim() || '';
  const phone   = msgEl.querySelector(SELECTORS.resumePhone)?.innerText.trim() || '';

  // 卡片尚未渲染完成（名字或电话为空），等下一次触发
  if (!name || !phone) return;

  // 卡片已完整渲染，标记元素和 msgId
  processedElements.add(msgEl);
  const msgId = getMsgId(msgEl);
  if (processedMsgIds.has(msgId)) return;
  processedMsgIds.add(msgId);

  const target  = msgEl.querySelector(SELECTORS.resumeTarget)?.innerText.trim().replace('投递职位-', '') || '';
  const desc    = msgEl.querySelector(SELECTORS.resumeDesc)?.innerText.trim() || '';

  // 解析描述字段：经验｜学历｜年龄｜求职状态
  const [experience = '', education = '', age = '', jobStatus = ''] = desc.split(/[｜|]/);

  const candidate = {
    name,
    target,
    experience: experience.trim(),
    education: education.trim(),
    age: age.trim(),
    jobStatus: jobStatus.trim(),
    phone,
    timestamp: Date.now(),
  };

  console.log('[58自动回复] 收到简历:', candidate);

  // 抓取当前完整对话记录
  const conversation = captureConversation();

  // 存入 chrome.storage + 发 QQ 通知 + 自动回复
  chrome.storage.local.get({ candidates: [] }, ({ candidates }) => {
    const exists = candidates.some(c => c.msgId === msgId);
    if (!exists) {
      candidates.unshift({ ...candidate, msgId, conversation });
      if (candidates.length > 1000) candidates.length = 1000;
      chrome.storage.local.set({ candidates });

      // 通知 service worker 发 QQ 群消息
      chrome.runtime.sendMessage({
        type: 'RESUME_RECEIVED',
        candidate,
        conversation,
      });

      // 自动回复求职者
      enqueueSend('好的，简历已收到！我马上联系咨询师给您联系，请保持电话畅通。', 3000, '简历已投，请多关注，谢谢');
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

// --- 启动 ---
init();
