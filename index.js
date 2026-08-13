/**
 * 鸠占鹊巢·记忆核心（NTR MemoryCore）
 * ------------------------------------------------------------------
 * 作用：把「剧情记忆」搬出 AI 的大脑，存进本地，并在每次生成前
 *      智能注入回上下文——解决 deepseek 长对话里数值丢失、前后文
 *      对不上、多线切换错乱的问题。
 *
 * 工作流：
 *   1. 监听消息 → 每 5 条消息用主 API 做一次结构化提取（标签/人物/
 *      数值/时间/地点/事件）→ 归档。
 *   2. 数值快照：只保留每人一份（覆盖更新），体积固定。
 *   3. 事件时间线：滚动窗口（保留最近 N 条），滚出的压成「阶段摘要」。
 *   4. 阶段摘要：缓慢增长，超限再合并成「总纲」。
 *   5. 生成前（拦截器）：注入「数值快照 + 近期时间线 + 相关摘要」，
 *      总量稳定，不随游戏时长无限膨胀。
 *
 * 所有总结/压缩都调用「主 API」（generateRaw），不依赖本地规则。
 * ------------------------------------------------------------------
 */
import { eventSource, event_types, generateRaw, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { registerSlashCommand } from '../../slash-commands.js';

const MODULE = 'ntr-memory';

// 这张卡的角色名单（用于让主 API 更准确地识别出场人物；可自行增删）
const KNOWN_CHARACTERS = [
    // 女性 NPC
    '沈清璃', '沈若薇', '沈知夏', '沈知禾', '楚岚', '周若曦', '周小满', '沈知桃',
    // 苦主
    '陆国梁', '赵明远', '顾北辰', '顾怀瑾', '周震', '方景行', '程一川', '周野',
];

// 需要追踪的数值字段（与卡片状态栏一致）
const VALUE_FIELDS = ['好感', '沉沦', '背德', '暴露', '服从', '发现'];

const DEFAULTS = {
    enabled: true,
    queueSize: 5,      // 每 5 条消息总结一次（可调）
    timelineMax: 15,   // 时间线保留最近 15 条事件
    summaryEvery: 15,  // 每 15 条事件压成 1 段阶段摘要
    summaryMax: 10,    // 阶段摘要保留最近 10 段
    worldview: '',     // 常驻世界观：每次生成前优先注入，历史被截断也不丢基础设定
    pending: [],       // 待总结的消息队列 [{role, text}]
    snapshot: {},      // 数值快照 {人物名: {好感, 沉沦, 背德, 暴露, 服从, 发现}}
    timeline: [],      // 事件时间线 [{time, location, characters, event, tags}]
    summaries: [],     // 阶段摘要 [文本]
    grandSummary: '',  // 总纲（更早摘要的合并）
};

// ---------- 存储 ----------

function getMem() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = JSON.parse(JSON.stringify(DEFAULTS));
    } else {
        // 合并新增字段（插件升级兼容）
        for (const [k, v] of Object.entries(DEFAULTS)) {
            if (!(k in extension_settings[MODULE])) {
                extension_settings[MODULE][k] = JSON.parse(JSON.stringify(v));
            }
        }
    }
    return extension_settings[MODULE];
}

function persist() {
    try { saveSettingsDebounced(); } catch (e) { /* 忽略 */ }
}

// ---------- 工具 ----------

/** 从模型输出中稳健地提取 JSON 对象 */
function extractJson(text) {
    if (!text) return null;
    // 直接尝试
    try { return JSON.parse(text); } catch { /* 继续 */ }
    // 去掉 markdown 代码块围栏
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
        try { return JSON.parse(fence[1].trim()); } catch { /* 继续 */ }
    }
    // 提取第一个 {...} 块（尽量配对）
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
            }
        }
    }
    return null;
}

function snapshotToText(snapshot) {
    const lines = Object.entries(snapshot).map(([name, v]) => {
        const parts = VALUE_FIELDS.map(f => `${f}${v[f] ?? '?'}`);
        return `${name}：${parts.join(' ')}`;
    });
    return lines.join('\n');
}

// ---------- 结构化提取（调主 API） ----------

function buildExtractPrompt(historyText, snapshotText) {
    return [
        '你是剧情记忆归档器。阅读下面这段对话，提取关键信息，输出一个 JSON 对象（不要 markdown 代码块、不要任何解释）。',
        '',
        '【已知人物名单（优先从里面识别，出现新人名也照实记录）】',
        KNOWN_CHARACTERS.join('、'),
        '',
        '【当前已有数值快照（用于增量更新：本次没提到的人物/数值保持原值，不要编造）】',
        snapshotText || '（暂无）',
        '',
        '【待归档的对话】',
        historyText,
        '',
        '【输出 JSON 格式】',
        '{',
        '  "tags": ["关键词1", "关键词2"],',
        '  "characters": ["出场人物名"],',
        '  "values": {',
        '    "人物名": {"好感": 数字或null, "沉沦": 数字或null, "背德": 数字或null, "暴露": 数字或null, "服从": 数字或null, "发现": 数字或null}',
        '  },',
        '  "time": "时间（如：第二天晚上 / 无明确时间则写 null）",',
        '  "location": "地点（如：别墅厨房 / 大学教室）",',
        '  "event": "一句话概括本段关键事件（谁对谁做了什么、谁发现了什么，要具体）"',
        '}',
        '',
        '规则：只提取对话中明确出现的信息，没出现的一律填 null 或省略；event 必须具体，不能是空话。',
    ].join('\n');
}

async function callMainApi(prompt, systemPrompt, responseLength) {
    try {
        const result = await generateRaw({
            prompt,
            systemPrompt: systemPrompt || '你是剧情记忆归档器，只输出要求的文本，不要任何额外解释。',
            responseLength,
        });
        return (typeof result === 'string' ? result : '').trim();
    } catch (e) {
        console.error('[ntr-memory] 主 API 调用失败：', e);
        return '';
    }
}

// ---------- 总结流程 ----------

let summarizing = false;
let processedIds = new Set();

function pushMessage(messageId) {
    const mem = getMem();
    if (!mem.enabled) return false;
    const context = getContext();
    const msg = context.chat?.[messageId];
    if (!msg || !msg.mes) return false;
    if (processedIds.has(messageId)) return false;
    // 跳过系统/注入消息，避免把记忆注入当剧情总结
    if (msg.extra?.type === 'narrator' || msg.extra?.type === 'memory') return false;
    processedIds.add(messageId);
    if (processedIds.size > 10000) processedIds.clear(); // 防无限增长

    const role = msg.is_user ? '玩家' : '角色';
    mem.pending.push({ role, text: String(msg.mes) });
    return !msg.is_user; // 返回是否为 AI 消息（AI 消息才触发总结检查）
}

function checkSummarize() {
    const mem = getMem();
    if (mem.pending.length >= mem.queueSize) {
        // 轻微延迟，确保主生成完全结束后再调用 API，避免抢占
        setTimeout(() => scheduleSummarize(), 800);
    }
}

async function scheduleSummarize() {
    const mem = getMem();
    if (summarizing) return;
    if (mem.pending.length < mem.queueSize) return;
    summarizing = true;
    try {
        const batch = mem.pending.splice(0, mem.queueSize);
        await summarizeBatch(batch);
    } finally {
        summarizing = false;
        // 队列还有剩余就继续
        if (mem.pending.length >= mem.queueSize) {
            setTimeout(() => scheduleSummarize(), 500);
        }
    }
}

async function summarizeBatch(batch) {
    const mem = getMem();
    const historyText = batch.map((m, i) => `${i + 1}. [${m.role}] ${m.text}`).join('\n');
    const snapshotText = snapshotToText(mem.snapshot);

    const result = await callMainApi(
        buildExtractPrompt(historyText, snapshotText),
        '你是剧情记忆归档器，只输出 JSON，不要任何解释。',
        600,
    );
    if (!result) return;

    const event = extractJson(result);
    if (!event) {
        console.warn('[ntr-memory] 无法解析总结 JSON，跳过本次：', result.slice(0, 200));
        return;
    }

    // 1) 数值快照覆盖更新
    if (event.values && typeof event.values === 'object') {
        for (const [name, vals] of Object.entries(event.values)) {
            if (!vals || typeof vals !== 'object') continue;
            const prev = mem.snapshot[name] || {};
            const next = { ...prev };
            for (const f of VALUE_FIELDS) {
                if (typeof vals[f] === 'number') next[f] = vals[f];
            }
            next._updatedAt = Date.now();
            mem.snapshot[name] = next;
        }
    }

    // 2) 追加时间线
    mem.timeline.push({
        time: event.time || '',
        location: event.location || '',
        characters: Array.isArray(event.characters) ? event.characters : [],
        event: event.event || '',
        tags: Array.isArray(event.tags) ? event.tags : [],
    });

    // 3) 时间线滚动 → 压成阶段摘要
    if (mem.timeline.length > mem.timelineMax) {
        const overflow = mem.timeline.splice(0, mem.timeline.length - mem.timelineMax);
        await rollToSummary(overflow);
    }

    persist();
}

async function rollToSummary(events) {
    const mem = getMem();
    const text = events
        .map(e => `[${e.time || '?'}] ${e.location || '?'}｜${e.characters.join('、')}｜${e.event}`)
        .join('\n');
    let summary = '';
    try {
        summary = await callMainApi(
            `请把下面这些剧情事件压缩成一段连贯的「阶段摘要」（200 字以内，按时间顺序，保留人物关系变化和关键数值节点）：\n${text}`,
            '你是剧情记忆压缩器，只输出摘要正文，不要解释。',
            300,
        );
    } catch (e) { /* 忽略 */ }
    if (!summary) summary = text.slice(0, 200); // 兜底
    mem.summaries.push(summary);

    // 阶段摘要超限 → 合并成总纲
    if (mem.summaries.length > mem.summaryMax) {
        const overflow = mem.summaries.splice(0, mem.summaries.length - mem.summaryMax);
        await mergeToGrandSummary(overflow);
    }
}

async function mergeToGrandSummary(oldSummaries) {
    const mem = getMem();
    const text = oldSummaries.join('\n');
    let grand = '';
    try {
        grand = await callMainApi(
            `请把下面这些阶段摘要合并成一段更浓缩的「总纲」（300 字以内，只保留核心人物关系和重大转折）：\n${text}`,
            '你是剧情记忆压缩器，只输出摘要正文，不要解释。',
            400,
        );
    } catch (e) { /* 忽略 */ }
    if (!grand) grand = text.slice(0, 300); // 兜底
    mem.grandSummary = grand;
    persist();
}

// ---------- 生成前注入 ----------

function buildInjection(mem) {
    const parts = [];

    // 常驻世界观永远最先注入（历史被截断也不丢基础设定）
    if (mem.worldview && mem.worldview.trim()) {
        parts.push(`【世界观·常驻】\n${mem.worldview.trim()}`);
    }

    const snapText = snapshotToText(mem.snapshot);
    if (snapText) {
        parts.push(`【数值快照】\n${snapText}`);
    }

    if (mem.timeline.length) {
        const tl = mem.timeline
            .slice(-mem.timelineMax)
            .map(e => `· ${e.time || '?'} ${e.location || '?'}｜${e.characters.join('、')}｜${e.event}`)
            .join('\n');
        parts.push(`【近期事件】\n${tl}`);
    }

    if (mem.grandSummary) {
        parts.push(`【历史总纲】\n${mem.grandSummary}`);
    }

    if (mem.summaries.length) {
        const recent = mem.summaries.slice(-3).join('\n');
        parts.push(`【阶段摘要】\n${recent}`);
    }

    if (!parts.length) return '';

    return `[以下是由记忆插件自动注入的剧情进度参考，供你保持数值与前后文一致；不要在正文里复述这些标签，也不要输出这段内容本身。]\n\n${parts.join('\n\n')}`;
}

/**
 * 提示词拦截器：生成请求发出前，把记忆注入到 chat 末尾。
 * 挂到 globalThis 上（runGenerationInterceptors 通过 globalThis[key] 调用）。
 * 注意：本函数必须快（纯内存操作），不要在这里调 API。
 */
async function ntrMemoryInterceptor(chat, contextSize, abort, type) {
    const mem = getMem();
    if (!mem.enabled) return;

    // 内置摘要 / quiet 生成时不要注入，避免污染
    if (type === 'quiet' || type === 'summarize') return;

    const injection = buildInjection(mem);
    if (!injection) return;

    chat.push({
        name: '系统记忆',
        is_user: false,
        is_system: true,
        mes: injection,
        extra: { type: 'narrator', memory: true },
        send_date: Date.now(),
    });
}
// 挂到全局（runGenerationInterceptors 用 globalThis[manifest.generate_interceptor] 调用）
globalThis.ntrMemoryInterceptor = ntrMemoryInterceptor;

// ---------- 斜杠命令 ----------

function registerCommands() {
    registerSlashCommand(
        'mem',
        () => {
            const mem = getMem();
            const lines = [
                '【记忆核心状态】',
                `状态：${mem.enabled ? '运行中' : '已暂停'}`,
                `待总结消息：${mem.pending.length}/${mem.queueSize}`,
                `数值快照人物：${Object.keys(mem.snapshot).length} 人`,
                `时间线事件：${mem.timeline.length}/${mem.timelineMax} 条`,
                `阶段摘要：${mem.summaries.length}/${mem.summaryMax} 段`,
                `总纲：${mem.grandSummary ? '已生成' : '无'}`,
            ];
            if (Object.keys(mem.snapshot).length) {
                lines.push('', '—— 数值快照 ——');
                lines.push(snapshotToText(mem.snapshot));
            }
            return lines.join('\n');
        },
        [],
        '查看记忆核心状态与当前数值快照',
    );

    registerSlashCommand(
        'mem-clear',
        () => {
            const mem = getMem();
            mem.pending = [];
            mem.snapshot = {};
            mem.timeline = [];
            mem.summaries = [];
            mem.grandSummary = '';
            processedIds.clear();
            persist();
            return '[记忆核心] 已清空全部记忆。';
        },
        [],
        '清空记忆核心的全部记忆',
    );

    registerSlashCommand(
        'mem-sum',
        () => {
            const mem = getMem();
            if (mem.pending.length === 0) {
                return '[记忆核心] 没有待总结的消息。';
            }
            const batch = mem.pending.splice(0, mem.pending.length);
            summarizeBatch(batch); // 后台总结，不阻塞
            return '[记忆核心] 已触发总结，稍后用 /mem 查看结果。';
        },
        [],
        '立即总结当前待处理消息',
    );

    registerSlashCommand(
        'mem-set',
        (args) => {
            const mem = getMem();
            const text = typeof args === 'string' ? args : (args?.value ?? String(args ?? ''));
            const parts = text.trim().split(/\s+/);
            if (parts.length < 3) {
                return `[mem-set 用法] /mem-set 人物 字段 值\n例如：/mem-set 沈清璃 好感 80\n字段：${VALUE_FIELDS.join('/')}`;
            }
            const name = parts[0];
            const field = parts[1];
            const val = Number(parts[2]);
            if (!VALUE_FIELDS.includes(field)) {
                return `[mem-set] 字段必须是：${VALUE_FIELDS.join('、')}`;
            }
            if (Number.isNaN(val)) {
                return '[mem-set] 数值必须是数字。';
            }
            mem.snapshot[name] = mem.snapshot[name] || {};
            mem.snapshot[name][field] = val;
            persist();
            return `[mem-set] 已设置 ${name} 的 ${field}=${val}`;
        },
        [],
        '手动修改数值快照：/mem-set 人物 字段 值',
    );

    registerSlashCommand(
        'mem-rm',
        (args) => {
            const mem = getMem();
            const text = typeof args === 'string' ? args : (args?.value ?? String(args ?? ''));
            const name = text.trim();
            if (!name) return '[mem-rm 用法] /mem-rm 人物';
            if (mem.snapshot[name]) {
                delete mem.snapshot[name];
                persist();
                return `[mem-rm] 已删除 ${name} 的数值快照。`;
            }
            return `[mem-rm] 快照里没有「${name}」。`;
        },
        [],
        '删除某人的数值快照：/mem-rm 人物',
    );
}

// ---------- 设置面板（可视化改记忆 / 调参数） ----------

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildSettingsHtml() {
    return `
    <div id="ntr-memory-settings" class="ntrmem-panel">
        <h3>鸠占鹊巢·记忆核心</h3>
        <label style="display:block;margin-bottom:6px;"><input type="checkbox" id="ntrmem-enabled"> 启用记忆注入</label>
        <hr>
        <div class="ntrmem-row">总结楼层（每几条消息总结一次）：<input type="number" id="ntrmem-queue" min="2" max="50" style="width:70px"></div>
        <div class="ntrmem-row">时间线保留条数：<input type="number" id="ntrmem-tlmax" min="5" max="200" style="width:70px"></div>
        <div class="ntrmem-row">每几条事件压一段摘要：<input type="number" id="ntrmem-sumevery" min="5" max="200" style="width:70px"></div>
        <div class="ntrmem-row">摘要保留段数：<input type="number" id="ntrmem-summax" min="1" max="100" style="width:70px"></div>
        <hr>
        <div class="ntrmem-label">常驻世界观（每次生成前优先注入，历史被截断也不丢基础设定）：</div>
        <textarea id="ntrmem-worldview" rows="4" style="width:100%" placeholder="粘贴世界观/基础设定，例如：临海市 · 重组家庭+校园 · 主角背债复仇 · 金手指「暗房」App · 全员成年、无血亲"></textarea>
        <hr>
        <div class="ntrmem-label">数值快照（可直接改，改完自动生效）：</div>
        <div id="ntrmem-snapshot"></div>
        <button id="ntrmem-addperson" style="margin-top:4px">＋ 新增人物</button>
        <hr>
        <div class="ntrmem-label">事件时间线（可删单条）：</div>
        <div id="ntrmem-timeline"></div>
        <hr>
        <div class="ntrmem-label">历史总纲：</div>
        <textarea id="ntrmem-grand" rows="3" style="width:100%"></textarea>
        <div class="ntrmem-label">阶段摘要：</div>
        <div id="ntrmem-summaries"></div>
        <hr>
        <button id="ntrmem-clear" style="color:#d33">清空全部记忆</button>
    </div>`;
}

function renderSnapshot(mem) {
    const container = document.getElementById('ntrmem-snapshot');
    if (!container) return;
    const names = Object.keys(mem.snapshot);
    if (!names.length) {
        container.innerHTML = '<div style="color:#888">（暂无，总结后自动出现）</div>';
        return;
    }
    let html = '<table class="ntrmem-table"><tr><th>人物</th>';
    for (const f of VALUE_FIELDS) html += `<th>${f}</th>`;
    html += '<th></th></tr>';
    for (const name of names) {
        html += `<tr><td>${escapeHtml(name)}</td>`;
        for (const f of VALUE_FIELDS) {
            const v = mem.snapshot[name][f] ?? '';
            html += `<td><input type="number" class="ntrmem-val" data-name="${escapeHtml(name)}" data-field="${f}" value="${v}" style="width:52px"></td>`;
        }
        html += `<td><button class="ntrmem-del" data-name="${escapeHtml(name)}">删</button></td></tr>`;
    }
    html += '</table>';
    container.innerHTML = html;

    container.querySelectorAll('.ntrmem-val').forEach(inp => {
        inp.addEventListener('change', () => {
            const m = getMem();
            const name = inp.dataset.name;
            const field = inp.dataset.field;
            const v = Number(inp.value);
            if (Number.isNaN(v)) return;
            if (m.snapshot[name]) {
                m.snapshot[name][field] = v;
                persist();
            }
        });
    });
    container.querySelectorAll('.ntrmem-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const m = getMem();
            delete m.snapshot[btn.dataset.name];
            persist();
            renderSettings();
        });
    });
}

function renderTimeline(mem) {
    const container = document.getElementById('ntrmem-timeline');
    if (!container) return;
    if (!mem.timeline.length) {
        container.innerHTML = '<div style="color:#888">（暂无）</div>';
        return;
    }
    let html = '';
    mem.timeline.forEach((e, i) => {
        html += `<div class="ntrmem-item"><span>${escapeHtml(e.time || '?')} ${escapeHtml(e.location || '?')}｜${escapeHtml((e.characters || []).join('、'))}｜${escapeHtml(e.event || '')}</span> <button class="ntrmem-tl-del" data-index="${i}">删</button></div>`;
    });
    container.innerHTML = html;
    container.querySelectorAll('.ntrmem-tl-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const m = getMem();
            const i = Number(btn.dataset.index);
            if (!Number.isNaN(i)) { m.timeline.splice(i, 1); persist(); renderSettings(); }
        });
    });
}

function renderSummaries(mem) {
    const container = document.getElementById('ntrmem-summaries');
    if (!container) return;
    if (!mem.summaries.length) {
        container.innerHTML = '<div style="color:#888">（暂无）</div>';
        return;
    }
    let html = '';
    mem.summaries.forEach((s, i) => {
        html += `<div class="ntrmem-item">${i + 1}. ${escapeHtml(s)} <button class="ntrmem-sum-del" data-index="${i}">删</button></div>`;
    });
    container.innerHTML = html;
    container.querySelectorAll('.ntrmem-sum-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const m = getMem();
            const i = Number(btn.dataset.index);
            if (!Number.isNaN(i)) { m.summaries.splice(i, 1); persist(); renderSettings(); }
        });
    });
}

function renderSettings() {
    const mem = getMem();
    const $enabled = document.getElementById('ntrmem-enabled');
    if (!$enabled) return;
    $enabled.checked = mem.enabled;
    document.getElementById('ntrmem-queue').value = mem.queueSize;
    document.getElementById('ntrmem-tlmax').value = mem.timelineMax;
    document.getElementById('ntrmem-sumevery').value = mem.summaryEvery;
    document.getElementById('ntrmem-summax').value = mem.summaryMax;
    document.getElementById('ntrmem-worldview').value = mem.worldview;
    document.getElementById('ntrmem-grand').value = mem.grandSummary;
    renderSnapshot(mem);
    renderTimeline(mem);
    renderSummaries(mem);
}

function bindSettingsEvents() {
    document.getElementById('ntrmem-enabled').addEventListener('change', e => {
        getMem().enabled = e.target.checked;
        persist();
    });
    const bindNum = (id, key) => {
        document.getElementById(id).addEventListener('change', e => {
            const v = Math.max(1, Number(e.target.value) || 1);
            getMem()[key] = v;
            persist();
        });
    };
    bindNum('ntrmem-queue', 'queueSize');
    bindNum('ntrmem-tlmax', 'timelineMax');
    bindNum('ntrmem-sumevery', 'summaryEvery');
    bindNum('ntrmem-summax', 'summaryMax');

    document.getElementById('ntrmem-worldview').addEventListener('change', e => {
        getMem().worldview = e.target.value;
        persist();
    });
    document.getElementById('ntrmem-grand').addEventListener('change', e => {
        getMem().grandSummary = e.target.value;
        persist();
    });
    document.getElementById('ntrmem-addperson').addEventListener('click', () => {
        const name = prompt('人物名：');
        if (!name || !name.trim()) return;
        const mem = getMem();
        const n = name.trim();
        if (!mem.snapshot[n]) mem.snapshot[n] = {};
        persist();
        renderSettings();
    });
    document.getElementById('ntrmem-clear').addEventListener('click', () => {
        if (!confirm('确定清空全部记忆？')) return;
        const mem = getMem();
        mem.pending = [];
        mem.snapshot = {};
        mem.timeline = [];
        mem.summaries = [];
        mem.grandSummary = '';
        processedIds.clear();
        persist();
        renderSettings();
    });
}

function mountSettings() {
    const container = document.getElementById('extensions_settings');
    if (!container) return;
    if (document.getElementById('ntr-memory-settings')) return; // 已挂载
    container.insertAdjacentHTML('beforeend', buildSettingsHtml());
    bindSettingsEvents();
    renderSettings();
}

// ---------- 启动 ----------

let initialized = false;

function init() {
    if (initialized) return;
    initialized = true;
    getMem();
    eventSource.on(event_types.MESSAGE_SENT, (messageId) => {
        pushMessage(messageId); // 玩家消息进队列
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
        const isAI = pushMessage(messageId); // AI 消息进队列
        if (isAI) checkSummarize(); // 只在 AI 回复完成后触发总结
    });
    try { registerCommands(); } catch (e) { console.warn('[ntr-memory] 命令注册失败：', e); }
    try { mountSettings(); } catch (e) { console.warn('[ntr-memory] 设置面板挂载失败：', e); }
    console.log('[ntr-memory] 记忆核心已启动。');
}

// 等待 SillyTavern 就绪后初始化（幂等，只跑一次）
if (document.readyState === 'complete') {
    init();
} else {
    window.addEventListener('load', init);
}
try {
    eventSource.on(event_types.APP_READY, init);
} catch (e) { /* 忽略 */ }
