// =============================================================================
// 58微聊自动回复 - Popup 配置界面
// =============================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- Tab 切换 ---
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'logs') loadLogs();
    if (tab.dataset.tab === 'candidates') loadCandidates();
  });
});

// --- 开关 ---
$('#enableToggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  await chrome.storage.local.set({ enabled });
  $('#statusText').textContent = enabled ? '已开启' : '已关闭';
});

// --- 加载配置 ---
async function loadConfig() {
  const config = await chrome.storage.local.get({
    enabled: true,
    rules: [],
    fallbackReply: '',
    delayMin: 3000,
    delayMax: 8000,
    hourlyLimit: 40,
    nightPauseStart: 0,
    nightPauseEnd: 7,
    visitorGreetingEnabled: true,
    visitorIgnoreAge: false,
    visitorAgeMin: 20,
    visitorAgeMax: 30,
    scanIntervalMin: 30,
    scanIntervalMax: 90,
    visitorScanIntervalMin: 60,
    visitorScanIntervalMax: 180,
  });

  $('#enableToggle').checked = config.enabled;
  $('#statusText').textContent = config.enabled ? '已开启' : '已关闭';
  $('#fallbackReply').value = config.fallbackReply;
  $('#delayMin').value = config.delayMin / 1000;
  $('#delayMax').value = config.delayMax / 1000;
  $('#hourlyLimit').value = config.hourlyLimit;
  $('#nightStart').value = config.nightPauseStart;
  $('#nightEnd').value = config.nightPauseEnd;
  $('#scanIntervalMin').value = config.scanIntervalMin;
  $('#scanIntervalMax').value = config.scanIntervalMax;
  $('#visitorScanIntervalMin').value = config.visitorScanIntervalMin;
  $('#visitorScanIntervalMax').value = config.visitorScanIntervalMax;

  // 访客设置
  $('#visitorGreetingEnabled').checked = config.visitorGreetingEnabled;
  $('#visitorIgnoreAge').checked = config.visitorIgnoreAge;
  $('#visitorAgeMin').value = config.visitorAgeMin;
  $('#visitorAgeMax').value = config.visitorAgeMax;
  $('#visitorSettingsGroup').style.display = config.visitorGreetingEnabled ? '' : 'none';
  $('#visitorAgeRange').style.display = config.visitorIgnoreAge ? 'none' : '';

  renderRules(config.rules);
  loadStatus();
}

// --- 状态 ---
async function loadStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (status) {
      if (status.tabStats && status.tabStats.length > 0) {
        const parts = status.tabStats.map(t => `账号${t.tabId}: ${t.count}/${t.limit}`);
        $('#stats').textContent = '本小时: ' + parts.join(' · ');
      } else {
        $('#stats').textContent = '本小时已回复: 0 / ' + status.hourlyLimit;
      }
    }
  } catch {
    $('#stats').textContent = '';
  }
}

// --- 渲染规则列表 ---
function renderRules(rules) {
  const container = $('#rulesList');
  if (!rules.length) {
    container.innerHTML = '<p class="empty-hint">暂无规则，点击"+ 添加"创建</p>';
    return;
  }

  container.innerHTML = rules
    .map(
      (rule) => `
    <div class="rule-item" data-id="${rule.id}">
      <div class="rule-keywords">
        ${rule.keywords.map((kw) => `<span class="rule-keyword">${escapeHtml(kw)}</span>`).join('')}
      </div>
      <div class="rule-reply">${escapeHtml(rule.reply)}</div>
      <div class="rule-mode">${rule.matchMode === 'exact' ? '精确匹配' : '模糊匹配'}</div>
      <div class="rule-actions">
        <button class="btn btn-sm edit-rule" data-id="${rule.id}">编辑</button>
        <button class="btn btn-sm btn-danger delete-rule" data-id="${rule.id}">删除</button>
      </div>
    </div>
  `
    )
    .join('');

  // 绑定编辑/删除事件
  container.querySelectorAll('.edit-rule').forEach((btn) => {
    btn.addEventListener('click', () => openEditRule(btn.dataset.id));
  });

  container.querySelectorAll('.delete-rule').forEach((btn) => {
    btn.addEventListener('click', () => deleteRule(btn.dataset.id));
  });
}

// --- 添加规则 ---
$('#addRuleBtn').addEventListener('click', () => {
  $('#modalTitle').textContent = '添加规则';
  $('#ruleKeywords').value = '';
  $('#ruleMatchMode').value = 'fuzzy';
  $('#ruleReply').value = '';
  $('#ruleEditId').value = '';
  $('#ruleModal').classList.remove('hidden');
});

// --- 编辑规则 ---
async function openEditRule(id) {
  const { rules = [] } = await chrome.storage.local.get({ rules: [] });
  const rule = rules.find((r) => r.id === id);
  if (!rule) return;

  $('#modalTitle').textContent = '编辑规则';
  $('#ruleKeywords').value = rule.keywords.join('\n');
  $('#ruleMatchMode').value = rule.matchMode || 'fuzzy';
  $('#ruleReply').value = rule.reply;
  $('#ruleEditId').value = id;
  $('#ruleModal').classList.remove('hidden');
}

// --- 保存规则 ---
$('#saveRule').addEventListener('click', async () => {
  const keywords = $('#ruleKeywords')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const reply = $('#ruleReply').value.trim();
  const matchMode = $('#ruleMatchMode').value;
  const editId = $('#ruleEditId').value;

  if (!keywords.length || !reply) {
    alert('请填写关键词和回复内容');
    return;
  }

  const { rules = [] } = await chrome.storage.local.get({ rules: [] });

  if (editId) {
    const idx = rules.findIndex((r) => r.id === editId);
    if (idx >= 0) {
      rules[idx] = { ...rules[idx], keywords, reply, matchMode };
    }
  } else {
    rules.push({
      id: Date.now().toString(36),
      keywords,
      reply,
      matchMode,
    });
  }

  await chrome.storage.local.set({ rules });
  renderRules(rules);
  $('#ruleModal').classList.add('hidden');
});

// --- 取消弹窗 ---
$('#cancelRule').addEventListener('click', () => {
  $('#ruleModal').classList.add('hidden');
});

// --- 删除规则 ---
async function deleteRule(id) {
  if (!confirm('确定删除此规则？')) return;

  const { rules = [] } = await chrome.storage.local.get({ rules: [] });
  const newRules = rules.filter((r) => r.id !== id);
  await chrome.storage.local.set({ rules: newRules });
  renderRules(newRules);
}

// --- 保存兜底回复 ---
$('#saveFallback').addEventListener('click', async () => {
  const fallbackReply = $('#fallbackReply').value.trim();
  await chrome.storage.local.set({ fallbackReply });
  showToast('兜底回复已保存');
});

// --- 访客打招呼开关 ---
$('#visitorGreetingEnabled').addEventListener('change', (e) => {
  $('#visitorSettingsGroup').style.display = e.target.checked ? '' : 'none';
});

// --- 不限年龄开关 ---
$('#visitorIgnoreAge').addEventListener('change', (e) => {
  $('#visitorAgeRange').style.display = e.target.checked ? 'none' : '';
});

// --- 保存设置 ---
$('#saveSettings').addEventListener('click', async () => {
  const delayMin = Math.max(1, parseInt($('#delayMin').value) || 3) * 1000;
  const delayMax = Math.max(delayMin / 1000 + 1, parseInt($('#delayMax').value) || 8) * 1000;
  const hourlyLimit = Math.max(1, parseInt($('#hourlyLimit').value) || 40);
  const nightPauseStart = parseInt($('#nightStart').value) || 0;
  const nightPauseEnd = parseInt($('#nightEnd').value) || 7;

  const visitorGreetingEnabled = $('#visitorGreetingEnabled').checked;
  const visitorIgnoreAge = $('#visitorIgnoreAge').checked;
  const visitorAgeMin = Math.max(16, parseInt($('#visitorAgeMin').value) || 20);
  const visitorAgeMax = Math.min(60, parseInt($('#visitorAgeMax').value) || 30);

  const scanIntervalMin = Math.max(5, parseInt($('#scanIntervalMin').value) || 30);
  const scanIntervalMax = Math.max(scanIntervalMin + 5, parseInt($('#scanIntervalMax').value) || 90);
  const visitorScanIntervalMin = Math.max(10, parseInt($('#visitorScanIntervalMin').value) || 60);
  const visitorScanIntervalMax = Math.max(visitorScanIntervalMin + 5, parseInt($('#visitorScanIntervalMax').value) || 180);

  await chrome.storage.local.set({
    delayMin,
    delayMax,
    hourlyLimit,
    nightPauseStart,
    nightPauseEnd,
    visitorGreetingEnabled,
    visitorIgnoreAge,
    visitorAgeMin,
    visitorAgeMax,
    scanIntervalMin,
    scanIntervalMax,
    visitorScanIntervalMin,
    visitorScanIntervalMax,
  });

  showToast('设置已保存');
});

// --- 日志 ---
async function loadLogs() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    const logs = status?.recentLogs || [];
    const container = $('#logsList');

    if (!logs.length) {
      container.innerHTML = '<p class="empty-hint">暂无回复记录</p>';
      return;
    }

    container.innerHTML = logs
      .map(
        (log) => `
      <div class="log-item">
        <div class="log-time">${formatTime(log.timestamp)}${log.tabId ? ' · 账号' + log.tabId : ''}</div>
        <div class="log-original">收到: ${escapeHtml(log.originalText || '')}</div>
        <div class="${log.success ? 'log-reply' : 'log-fail'}">
          ${log.success ? '回复' : '失败'}: ${escapeHtml(log.replyText || '')}
        </div>
      </div>
    `
      )
      .join('');
  } catch {
    $('#logsList').innerHTML = '<p class="empty-hint">加载失败</p>';
  }
}

$('#clearLogs').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
  $('#logsList').innerHTML = '<p class="empty-hint">暂无回复记录</p>';
});

// --- 工具函数 ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.textContent = msg;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '20px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#333',
    color: '#fff',
    padding: '8px 16px',
    borderRadius: '6px',
    fontSize: '13px',
    zIndex: '999',
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// --- 简历列表 ---
async function loadCandidates() {
  const { candidates = [] } = await chrome.storage.local.get({ candidates: [] });
  const container = $('#candidatesList');
  $('#candidateCount').textContent = candidates.length ? `(${candidates.length})` : '';

  if (!candidates.length) {
    container.innerHTML = '<p class="empty-hint">暂无简历记录</p>';
    return;
  }

  container.innerHTML = candidates.map((c, idx) => `
    <div class="candidate-item">
      <div class="candidate-name">${escapeHtml(c.name)}
        <span class="conv-count">${c.conversation?.length || 0} 条对话</span>
      </div>
      <div class="candidate-target">${escapeHtml(c.target)}</div>
      <div class="candidate-desc">${[c.experience, c.education, c.age, c.jobStatus].filter(Boolean).join(' · ')}</div>
      <div class="candidate-phone">☎ ${escapeHtml(c.phone)}</div>
      <div class="candidate-time">${formatTime(c.timestamp)}</div>
      ${c.conversation?.length ? `
        <button class="btn btn-sm toggle-conv" data-idx="${idx}">展开对话</button>
        <div class="conversation hidden" id="conv-${idx}">
          ${renderConversation(c.conversation)}
        </div>
      ` : ''}
    </div>
  `).join('');

  // 绑定展开/折叠
  container.querySelectorAll('.toggle-conv').forEach(btn => {
    btn.addEventListener('click', () => {
      const conv = $(`#conv-${btn.dataset.idx}`);
      const collapsed = conv.classList.toggle('hidden');
      btn.textContent = collapsed ? '展开对话' : '收起对话';
    });
  });
}

function renderConversation(messages) {
  return messages.map(m => {
    if (m.role === 'system') {
      return `<div class="conv-system">${escapeHtml(m.text)}</div>`;
    }
    const isMe = m.role === 'me';
    return `<div class="conv-msg ${isMe ? 'conv-me' : 'conv-other'}">
      <span class="conv-role">${isMe ? '我' : '对方'}</span>
      ${m.time ? `<span class="conv-time">${escapeHtml(m.time)}</span>` : ''}
      <div class="conv-text">${escapeHtml(m.text)}</div>
    </div>`;
  }).join('');
}

// --- 导出 CSV ---
$('#exportCandidates').addEventListener('click', async () => {
  const { candidates = [] } = await chrome.storage.local.get({ candidates: [] });
  if (!candidates.length) { alert('暂无数据'); return; }

  const header = '姓名,投递职位,经验,学历,年龄,求职状态,电话,时间,对话记录';
  const rows = candidates.map(c => {
    const convText = (c.conversation || [])
      .map(m => `[${m.role === 'me' ? '我' : m.role === 'system' ? '系统' : '对方'}] ${m.text}`)
      .join(' | ');
    return [c.name, c.target, c.experience, c.education, c.age, c.jobStatus, c.phone, formatTime(c.timestamp), convText]
      .map(v => `"${(v||'').replace(/"/g,'""')}"`)
      .join(',');
  });

  const csv = '\uFEFF' + header + '\n' + rows.join('\n'); // \uFEFF = BOM，Excel 正确显示中文
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `简历_${new Date().toLocaleDateString('zh-CN').replace(/\//g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// --- 初始化 ---
loadConfig();
