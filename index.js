/**
 * 鸠占鹊巢·记忆核心（NTR MemoryCore）
 * ------------------------------------------------------------------
 * 作用：把「剧情记忆」搬出 AI 的大脑存进本地，并在每次生成前智能注入。
 * 记忆按「人物」分档：和谁互动只注入谁；多人同场的事件是「共有记忆」，
 * 同一条事件会归档到每个参与人名下。
 *
 * 结构：
 *   snapshot      —— 数值快照（按人分，覆盖更新，体积固定）
 *   characters    —— 剧情记忆（按人分：每人一条事件窗 + 一段摘要）
 *   globalEvents  —— 全局大事件轴（跨线大事件，保留全局时间顺序）
 *   globalSummary —— 全局总纲
 *
 * 注入时：世界观 + 全局快照 + 当前活跃角色的剧情 + 全局大事件/总纲。
 * 所有总结/压缩都调用「主 API」（generateRaw）。
 * ------------------------------------------------------------------
 */
import { eventSource, event_types, generateRaw, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { registerSlashCommand } from '../../slash-commands.js';

const MODULE = 'ntr-memory';

// 这张卡的角色名单（用于识别出场人物、检测活跃角色；可自行增删）
const KNOWN_CHARACTERS = [
    // 女性 NPC
    '沈清璃', '沈若薇', '沈知夏', '沈知禾', '楚岚', '周若曦', '周小满', '沈知桃',
    // 苦主
    '陆国梁', '赵明远', '顾北辰', '顾怀瑾', '周震', '方景行', '程一川', '周野',
];

// 需要追踪的数值字段（与卡片状态栏一致）
const VALUE_FIELDS = ['好感', '沉沦', '背德', '暴露', '服从', '发现'];

// 苦主映射：女性 NPC → [苦主名, 关系]
const CUCKOLD_MAP = {
    '沈清璃': ['陆国梁', '丈夫（主角父亲）'],
    '沈若薇': ['赵明远', '未婚夫'],
    '沈知夏': ['顾北辰', '男友'],
    '沈知禾': ['顾怀瑾', '丈夫'],
    '楚岚': ['周震', '丈夫（周野父亲）'],
    '周若曦': ['方景行', '联姻未婚夫'],
    '周小满': ['程一川', '青梅竹马'],
    '沈知桃': ['周野', '男友（校霸）'],
};

const DEFAULTS = {
    enabled: true,
    queueSize: 5,        // 每几条消息总结一次（可调）
    eventsPerChar: 15,   // 每个角色保留最近几条事件（滚动窗口）
    summaryMaxLen: 500,  // 每个角色的摘要超过这个字数就重新压缩
    globalMax: 20,       // 全局大事件轴保留条数
    worldview: '',       // 常驻世界观：每次生成前优先注入
    pending: [],         // 待总结的消息队列 [{role, text}]
    snapshot: {},        // 数值快照 {人物名: {好感, 沉沦, 背德, 暴露, 服从, 发现}}
    characters: {},      // 剧情记忆 {人物名: {events: [], summary: ''}}
    globalEvents: [],    // 全局大事件轴 [{time, location, characters, event, tags}]
    globalSummary: '',   // 全局总纲
    mainlineSummary: '', // 主线大记忆：宏观主线总结（复仇/各线关系/苦主态势/暴雷风险）
};

// ---------- 存储 ----------

function getMem() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = JSON.parse(JSON.stringify(DEFAULTS));
    } else {
        const s = extension_settings[MODULE];
        for (const [k, v] of Object.entries(DEFAULTS)) {
            if (!(k in s)) s[k] = JSON.parse(JSON.stringify(v));
        }
        // 清理旧版字段（结构升级）
        for (const k of ['timeline', 'summaries', 'grandSummary', 'timelineMax', 'summaryEvery', 'summaryMax']) {
            if (k in s) delete s[k];
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
    try { return JSON.parse(text); } catch { /* 继续 */ }
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
        try { return JSON.parse(fence[1].trim()); } catch { /* 继续 */ }
    }
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

function eventToLine(e) {
    const before = e.before ? `前情：${e.before}｜` : '';
    return `· ${before}${e.time || '?'} ${e.location || '?'}｜${(e.characters || []).join('、')}｜${e.event || ''}`;
}

/** 从正文末尾的状态栏正则抓精确数值（双源校验的「精确源」） */
function extractStatusBar(text) {
    if (!text) return {};
    const out = {};
    let m;
    // 女性 NPC：沈清璃：好感80 沉沦66
    const npcRe = /([\u4e00-\u9fa5A-Za-z]{2,8})[：:]\s*好感\s*(\d+)\s*沉沦\s*(\d+)/g;
    while ((m = npcRe.exec(text))) {
        out[m[1]] = out[m[1]] || {};
        out[m[1]].好感 = Number(m[2]);
        out[m[1]].沉沦 = Number(m[3]);
    }
    // 苦主：陆国梁：服从30 发现55｜此刻在做什么
    const cuckRe = /([\u4e00-\u9fa5A-Za-z]{2,8})[：:]\s*服从\s*(\d+)\s*发现\s*(\d+)(?:[｜|]\s*([^｜|\n]*))?/g;
    while ((m = cuckRe.exec(text))) {
        out[m[1]] = out[m[1]] || {};
        out[m[1]].服从 = Number(m[2]);
        out[m[1]].发现 = Number(m[3]);
        if (m[4] && m[4].trim()) out[m[1]].动向 = m[4].trim();
    }
    return out;
}

/** 把状态栏正则抓到的数值写进快照（每轮 AI 回复后调用，精确、及时） */
function applyStatusBar(text) {
    const mem = getMem();
    const vals = extractStatusBar(text);
    let changed = false;
    for (const [name, fields] of Object.entries(vals)) {
        const prev = mem.snapshot[name] || {};
        const next = { ...prev };
        for (const [k, v] of Object.entries(fields)) {
            if (v !== undefined && v !== null && v !== '') next[k] = v;
        }
        next._updatedAt = Date.now();
        mem.snapshot[name] = next;
        changed = true;
    }
    if (changed) persist();
    return vals;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 结构化提取（调主 API） ----------

function buildExtractPrompt(historyText, snapshotText) {
    return [
        '你是剧情记忆归档器。阅读下面这段对话，提取关键信息，输出一个 JSON 对象（不要 markdown 代码块、不要任何解释）。',
        '',
        '【已知人物名单（优先从里面识别，出现新人名也照实记录）】',
        KNOWN_CHARACTERS.join('、'),
        '',
        '【当前已有数值快照（增量更新：本次没提到的人物/数值保持原值，不要编造）】',
        snapshotText || '（暂无）',
        '',
        '【待归档的对话】',
        historyText,
        '',
        '【输出 JSON 格式】',
        '{',
        '  "tags": ["关键词1", "关键词2"],',
        '  "before": "本段事件发生前，玩家在做什么、是怎么发展到这一步的（前情/起因，一句话）",',
        '  "characters": ["所有出场人物名"],',
        '  "mainCharacters": ["本段剧情的主互动对象（核心人物，通常 1-2 人；若玩家同时与两人互动则都写上）"],',
        '  "values": {',
        '    "人物名": {"好感": 数字或null, "沉沦": 数字或null, "背德": 数字或null, "暴露": 数字或null, "服从": 数字或null, "发现": 数字或null}',
        '  },',
        '  "time": "时间（如：第二天晚上 / 无明确时间则写 null）",',
        '  "location": "地点（如：别墅厨房 / 大学教室）",',
        '  "event": "一句话概括本段关键事件（谁对谁做了什么、谁发现了什么，要具体）",',
        '  "mainline": "本段对话对主线的宏观推进（复仇大计/各线攻略进度/苦主总体态势/暴雷风险，一句话；若本段只是日常、无主线推进则填 null）"',
        '}',
        '',
        '规则：只提取对话中明确出现的信息，没出现的一律填 null 或省略；before 必须写清「发生前玩家在做什么」，保证记忆能联动前因后果；mainCharacters 必须从出场人物里选；event 必须具体。',
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
    if (msg.extra?.type === 'narrator' || msg.extra?.type === 'memory') return false;
    processedIds.add(messageId);
    if (processedIds.size > 10000) processedIds.clear();

    const role = msg.is_user ? '玩家' : '角色';
    mem.pending.push({ role, text: String(msg.mes) });

    // AI 消息：从正文状态栏正则抓精确数值（每轮即时更新快照，双源校验的精确源）
    if (!msg.is_user) {
        try { applyStatusBar(String(msg.mes)); } catch (e) { /* 忽略 */ }
    }

    return !msg.is_user;
}

function checkSummarize() {
    const mem = getMem();
    if (mem.pending.length >= mem.queueSize) {
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

    // 2) 组装事件对象
    const ev = {
        before: event.before || '',
        time: event.time || '',
        location: event.location || '',
        characters: Array.isArray(event.characters) ? event.characters : [],
        event: event.event || '',
        tags: Array.isArray(event.tags) ? event.tags : [],
    };

    // 3) 归档到「主互动对象」名下（多人 = 共有记忆，每人各存一份）
    const mains = Array.isArray(event.mainCharacters) && event.mainCharacters.length
        ? event.mainCharacters
        : ev.characters;
    const archived = new Set();
    for (const name of mains) {
        if (!name || archived.has(name)) continue;
        archived.add(name);
        if (!mem.characters[name]) mem.characters[name] = { events: [], summary: '' };
        mem.characters[name].events.push({ ...ev });
        // 该角色事件窗超限 → 滚出压成摘要
        if (mem.characters[name].events.length > mem.eventsPerChar) {
            const overflow = mem.characters[name].events.splice(0, mem.characters[name].events.length - mem.eventsPerChar);
            await rollCharSummary(name, overflow);
        }
    }

    // 4) 全局大事件轴（所有事件都进，精简保留）
    mem.globalEvents.push({ ...ev });
    if (mem.globalEvents.length > mem.globalMax) {
        const overflow = mem.globalEvents.splice(0, mem.globalEvents.length - mem.globalMax);
        await rollGlobalSummary(overflow);
    }

    // 5) 主线大记忆：本段对主线的宏观推进 → 滚动压缩成连贯主线
    if (typeof event.mainline === 'string' && event.mainline.trim()) {
        await rollMainline(event.mainline.trim());
    }

    persist();
}

/** 把主线推进片段追加进主线大记忆（超长再压缩成连贯主线） */
async function rollMainline(piece) {
    const mem = getMem();
    mem.mainlineSummary = mem.mainlineSummary ? `${mem.mainlineSummary}\n${piece}` : piece;
    if (mem.mainlineSummary.length > mem.summaryMaxLen) {
        const old = mem.mainlineSummary;
        try {
            const merged = await callMainApi(
                `请把下面的主线总结压缩成一段连贯的宏观主线（400 字以内，保留复仇进度、各线关系进展、苦主总体态势、暴雷风险）：\n${old}`,
                '你是剧情主线压缩器，只输出主线正文，不要解释。',
                450,
            );
            if (merged) mem.mainlineSummary = merged;
        } catch (e) { /* 保留原样 */ }
    }
}

/** 把某角色滚出的事件压成一段摘要，追加到该角色 summary（超长再压缩） */
async function rollCharSummary(name, events) {
    const mem = getMem();
    const text = events.map(eventToLine).join('\n');
    let piece = '';
    try {
        piece = await callMainApi(
            `请把下面这些剧情事件压缩成一段连贯摘要（150 字以内，按时间顺序，保留人物关系和关键数值变化）：\n${text}`,
            '你是剧情记忆压缩器，只输出摘要正文，不要解释。',
            250,
        );
    } catch (e) { /* 忽略 */ }
    if (!piece) piece = text.slice(0, 150);

    const ch = mem.characters[name];
    ch.summary = ch.summary ? `${ch.summary}\n${piece}` : piece;

    // summary 超长 → 重新压缩成一段
    if (ch.summary.length > mem.summaryMaxLen) {
        const old = ch.summary;
        try {
            const merged = await callMainApi(
                `请把下面这位角色的历史摘要压缩成一段（400 字以内，保留人物关系与关键转折）：\n${old}`,
                '你是剧情记忆压缩器，只输出摘要正文。',
                450,
            );
            if (merged) ch.summary = merged;
        } catch (e) { /* 保留原样 */ }
    }
}

/** 把滚出的全局大事件压进全局总纲 */
async function rollGlobalSummary(events) {
    const mem = getMem();
    const text = events.map(eventToLine).join('\n');
    let piece = '';
    try {
        piece = await callMainApi(
            `请把下面这些全局大事件压缩成一段总纲（200 字以内，按时间顺序，保留跨线大转折与苦主起疑/暴雷节点）：\n${text}`,
            '你是剧情记忆压缩器，只输出摘要正文。',
            300,
        );
    } catch (e) { /* 忽略 */ }
    if (!piece) piece = text.slice(0, 200);
    mem.globalSummary = mem.globalSummary ? `${mem.globalSummary}\n${piece}` : piece;
    // 总纲超长压缩
    if (mem.globalSummary.length > mem.summaryMaxLen) {
        const old = mem.globalSummary;
        try {
            const merged = await callMainApi(
                `请把下面的全局总纲压缩成一段（400 字以内，保留核心人物关系和重大转折）：\n${old}`,
                '你是剧情记忆压缩器，只输出摘要正文。',
                450,
            );
            if (merged) mem.globalSummary = merged;
        } catch (e) { /* 保留原样 */ }
    }
}

// ---------- 活跃角色检测 ----------

function detectActiveCharacters() {
    const context = getContext();
    const chat = context.chat || [];
    const recent = chat.slice(-8);
    const found = new Set();
    for (const msg of recent) {
        const text = String(msg.mes || '');
        for (const name of KNOWN_CHARACTERS) {
            if (text.includes(name)) found.add(name);
        }
    }
    return [...found];
}

// ---------- 生成前注入 ----------

function buildInjection(mem) {
    const parts = [];

    // 常驻世界观永远最先注入
    if (mem.worldview && mem.worldview.trim()) {
        parts.push(`【世界观·常驻】\n${mem.worldview.trim()}`);
    }

    // 主线大记忆（宏观主线，始终注入）
    if (mem.mainlineSummary) {
        parts.push(`【主线大记忆】\n${mem.mainlineSummary}`);
    }

    // 数值快照（全量，按人，体积固定）
    const snapText = snapshotToText(mem.snapshot);
    if (snapText) {
        parts.push(`【数值快照】\n${snapText}`);
    }

    // 当前活跃角色的剧情记忆（和谁互动只注入谁）
    const active = detectActiveCharacters();
    for (const name of active) {
        const ch = mem.characters[name];
        if (!ch) continue;
        const evText = ch.events.slice(-mem.eventsPerChar).map(eventToLine).join('\n');
        const lines = [];
        if (evText) lines.push(`· 近期：\n${evText}`);
        if (ch.summary) lines.push(`· 摘要：\n${ch.summary}`);
        if (lines.length) parts.push(`【${name}的记忆】\n${lines.join('\n')}`);
    }

    // 苦主联动：活跃女 NPC 的苦主状态（服从/发现 + 动向）
    for (const name of active) {
        const ck = CUCKOLD_MAP[name];
        if (!ck) continue;
        const [cname, rel] = ck;
        const c = mem.snapshot[cname];
        if (!c) continue;
        const cp = [];
        if (c.服从 !== undefined) cp.push(`服从${c.服从}`);
        if (c.发现 !== undefined) cp.push(`发现${c.发现}`);
        if (c.动向) cp.push(`动向：${c.动向}`);
        if (cp.length) parts.push(`【苦主·${cname}（${rel}）】\n${cp.join(' ')}`);
    }

    // 全局大事件轴 + 总纲（精简，保留跨线视角）
    if (mem.globalEvents.length) {
        const g = mem.globalEvents.slice(-10).map(eventToLine).join('\n');
        parts.push(`【全局大事件】\n${g}`);
    }
    if (mem.globalSummary) {
        parts.push(`【全局总纲】\n${mem.globalSummary}`);
    }

    if (!parts.length) return '';

    return `[以下是由记忆插件自动注入的剧情进度参考，供你保持数值与前后文一致；不要在正文里复述这些标签，也不要输出这段内容本身。]\n\n${parts.join('\n\n')}`;
}

/**
 * 提示词拦截器：生成请求发出前，把记忆注入到 chat 末尾。
 * 挂到 globalThis 上（runGenerationInterceptors 通过 globalThis[key] 调用）。
 */
async function ntrMemoryInterceptor(chat, contextSize, abort, type) {
    const mem = getMem();
    if (!mem.enabled) return;
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
                `剧情记忆人物：${Object.keys(mem.characters).length} 人`,
                `全局大事件：${mem.globalEvents.length}/${mem.globalMax} 条`,
                `当前活跃：${detectActiveCharacters().join('、') || '（无）'}`,
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
            let done = false;
            if (mem.snapshot[name]) { delete mem.snapshot[name]; done = true; }
            if (mem.characters[name]) { delete mem.characters[name]; done = true; }
            if (done) { persist(); return `[mem-rm] 已删除 ${name} 的记忆。`; }
            return `[mem-rm] 记忆里没有「${name}」。`;
        },
        [],
        '删除某人的记忆（快照+剧情）：/mem-rm 人物',
    );

    registerSlashCommand(
        'mem-sum',
        () => {
            const mem = getMem();
            if (mem.pending.length === 0) {
                return '[记忆核心] 没有待总结的消息。';
            }
            const batch = mem.pending.splice(0, mem.pending.length);
            summarizeBatch(batch);
            return '[记忆核心] 已触发总结，稍后用 /mem 查看结果。';
        },
        [],
        '立即总结当前待处理消息',
    );

    registerSlashCommand(
        'mem-clear',
        () => {
            const mem = getMem();
            mem.pending = [];
            mem.snapshot = {};
            mem.characters = {};
            mem.globalEvents = [];
            mem.globalSummary = '';
            mem.mainlineSummary = '';
            processedIds.clear();
            persist();
            return '[记忆核心] 已清空全部记忆。';
        },
        [],
        '清空记忆核心的全部记忆',
    );

    registerSlashCommand(
        'mem-export',
        () => {
            const json = exportMemory();
            return `[记忆核心] 导出数据（复制下面这段到「导入记忆」粘贴即可）：\n\`\`\`json\n${json}\n\`\`\``;
        },
        [],
        '导出全部记忆为 JSON（复制后可用面板「导入记忆」恢复）',
    );
}

// ---------- 设置面板（可视化改记忆 / 调参数） ----------

function buildSettingsHtml() {
    return `
    <div id="ntr-memory-settings" class="ntrmem-panel">
        <h3>鸠占鹊巢·记忆核心</h3>
        <label style="display:block;margin-bottom:6px;"><input type="checkbox" id="ntrmem-enabled"> 启用记忆注入</label>
        <hr>
        <div class="ntrmem-row">总结楼层（每几条消息总结一次）：<input type="number" id="ntrmem-queue" min="2" max="50" style="width:70px"></div>
        <div class="ntrmem-row">每人事件窗保留条数：<input type="number" id="ntrmem-events" min="5" max="100" style="width:70px"></div>
        <div class="ntrmem-row">全局大事件保留条数：<input type="number" id="ntrmem-globalmax" min="5" max="100" style="width:70px"></div>
        <hr>
        <div class="ntrmem-label">常驻世界观（每次生成前优先注入，历史被截断也不丢基础设定）：</div>
        <textarea id="ntrmem-worldview" rows="4" style="width:100%" placeholder="粘贴世界观/基础设定，例如：临海市 · 重组家庭+校园 · 主角背债复仇 · 金手指「暗房」App · 全员成年、无血亲"></textarea>
        <hr>
        <div class="ntrmem-label">数值快照（可直接改，改完自动生效）：</div>
        <div id="ntrmem-snapshot"></div>
        <button id="ntrmem-addperson" style="margin-top:4px">＋ 新增人物</button>
        <hr>
        <div class="ntrmem-label">剧情记忆（按人分，可删单条事件）：</div>
        <div id="ntrmem-characters"></div>
        <hr>
        <div class="ntrmem-label">全局大事件轴（可删单条）：</div>
        <div id="ntrmem-globalevents"></div>
        <div class="ntrmem-label">主线大记忆（宏观主线，可编辑）：</div>
        <textarea id="ntrmem-mainline" rows="4" style="width:100%"></textarea>
        <div class="ntrmem-label">全局总纲：</div>
        <textarea id="ntrmem-globalsummary" rows="3" style="width:100%"></textarea>
        <hr>
        <div class="ntrmem-row">
            <button id="ntrmem-export">导出记忆</button>
            <button id="ntrmem-import">导入记忆</button>
        </div>
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

function renderCharacters(mem) {
    const container = document.getElementById('ntrmem-characters');
    if (!container) return;
    const names = Object.keys(mem.characters);
    if (!names.length) {
        container.innerHTML = '<div style="color:#888">（暂无，总结后自动出现）</div>';
        return;
    }
    let html = '';
    for (const name of names) {
        const ch = mem.characters[name];
        html += `<div class="ntrmem-char-block" style="border:1px solid #444;padding:6px;margin-bottom:6px;border-radius:4px">`;
        html += `<div class="ntrmem-char-title" data-name="${escapeHtml(name)}" style="cursor:pointer;font-weight:bold;user-select:none"><span class="ntrmem-arrow">▸</span> ${escapeHtml(name)}（事件 ${ch.events.length} 条）</div>`;
        html += `<div class="ntrmem-char-body" style="display:none;margin-top:4px">`;
        if (!ch.events.length) {
            html += `<div style="font-size:12px;color:#888">（暂无事件）</div>`;
        } else {
            ch.events.forEach((e, i) => {
                html += `<div style="font-size:12px;color:#bbb;margin-bottom:2px">${escapeHtml(eventToLine(e))} <button class="ntrmem-cev-del" data-name="${escapeHtml(name)}" data-index="${i}">删</button></div>`;
            });
        }
        html += `<textarea class="ntrmem-char-summary" data-name="${escapeHtml(name)}" rows="2" style="width:100%;margin-top:4px" placeholder="该角色的摘要（可编辑）">${escapeHtml(ch.summary || '')}</textarea>`;
        html += `</div>`;
        html += `</div>`;
    }
    container.innerHTML = html;

    // 点击角色名展开 / 收起
    container.querySelectorAll('.ntrmem-char-title').forEach(title => {
        title.addEventListener('click', () => {
            const body = title.nextElementSibling;
            const arrow = title.querySelector('.ntrmem-arrow');
            if (!body) return;
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? 'block' : 'none';
            if (arrow) arrow.textContent = hidden ? '▾' : '▸';
        });
    });

    // 删事件
    container.querySelectorAll('.ntrmem-cev-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const m = getMem();
            const ch = m.characters[btn.dataset.name];
            const i = Number(btn.dataset.index);
            if (ch && !Number.isNaN(i)) { ch.events.splice(i, 1); persist(); renderSettings(); }
        });
    });

    // 改摘要
    container.querySelectorAll('.ntrmem-char-summary').forEach(ta => {
        ta.addEventListener('change', () => {
            const m = getMem();
            const ch = m.characters[ta.dataset.name];
            if (ch) { ch.summary = ta.value; persist(); }
        });
    });
}

function renderGlobalEvents(mem) {
    const container = document.getElementById('ntrmem-globalevents');
    if (!container) return;
    if (!mem.globalEvents.length) {
        container.innerHTML = '<div style="color:#888">（暂无）</div>';
        return;
    }
    let html = '';
    mem.globalEvents.forEach((e, i) => {
        html += `<div style="font-size:12px;color:#bbb">${escapeHtml(eventToLine(e))} <button class="ntrmem-gev-del" data-index="${i}">删</button></div>`;
    });
    container.innerHTML = html;
    container.querySelectorAll('.ntrmem-gev-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const m = getMem();
            const i = Number(btn.dataset.index);
            if (!Number.isNaN(i)) { m.globalEvents.splice(i, 1); persist(); renderSettings(); }
        });
    });
}

function renderSettings() {
    const mem = getMem();
    const $enabled = document.getElementById('ntrmem-enabled');
    if (!$enabled) return;
    $enabled.checked = mem.enabled;
    document.getElementById('ntrmem-queue').value = mem.queueSize;
    document.getElementById('ntrmem-events').value = mem.eventsPerChar;
    document.getElementById('ntrmem-globalmax').value = mem.globalMax;
    document.getElementById('ntrmem-worldview').value = mem.worldview;
    document.getElementById('ntrmem-mainline').value = mem.mainlineSummary;
    document.getElementById('ntrmem-globalsummary').value = mem.globalSummary;
    renderSnapshot(mem);
    renderCharacters(mem);
    renderGlobalEvents(mem);
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
    bindNum('ntrmem-events', 'eventsPerChar');
    bindNum('ntrmem-globalmax', 'globalMax');

    document.getElementById('ntrmem-worldview').addEventListener('change', e => {
        getMem().worldview = e.target.value;
        persist();
    });
    document.getElementById('ntrmem-mainline').addEventListener('change', e => {
        getMem().mainlineSummary = e.target.value;
        persist();
    });
    document.getElementById('ntrmem-globalsummary').addEventListener('change', e => {
        getMem().globalSummary = e.target.value;
        persist();
    });
    document.getElementById('ntrmem-addperson').addEventListener('click', () => {
        const name = prompt('人物名：');
        if (!name || !name.trim()) return;
        const mem = getMem();
        const n = name.trim();
        if (!mem.snapshot[n]) mem.snapshot[n] = {};
        if (!mem.characters[n]) mem.characters[n] = { events: [], summary: '' };
        persist();
        renderSettings();
    });
    document.getElementById('ntrmem-clear').addEventListener('click', () => {
        if (!confirm('确定清空全部记忆？')) return;
        const mem = getMem();
        mem.pending = [];
        mem.snapshot = {};
        mem.characters = {};
        mem.globalEvents = [];
        mem.globalSummary = '';
        mem.mainlineSummary = '';
        processedIds.clear();
        persist();
        renderSettings();
    });
    document.getElementById('ntrmem-export').addEventListener('click', () => {
        const json = exportMemory();
        try { navigator.clipboard?.writeText(json); toastr?.success?.('记忆已复制到剪贴板'); } catch (e) { /* 忽略 */ }
        showTextDialog('导出记忆（已尝试复制，也可手动全选复制）：', json);
    });
    document.getElementById('ntrmem-import').addEventListener('click', showImportDialog);
}

function exportMemory() {
    const mem = getMem();
    const data = {
        _export: 'ntr-memory',
        _version: 1,
        _time: new Date().toISOString(),
        snapshot: mem.snapshot,
        characters: mem.characters,
        globalEvents: mem.globalEvents,
        globalSummary: mem.globalSummary,
        mainlineSummary: mem.mainlineSummary,
        worldview: mem.worldview,
    };
    return JSON.stringify(data, null, 2);
}

function importMemory(jsonText) {
    let data;
    try { data = JSON.parse(jsonText); } catch { return false; }
    if (!data || data._export !== 'ntr-memory') return false;
    const mem = getMem();
    if (data.snapshot && typeof data.snapshot === 'object') mem.snapshot = data.snapshot;
    if (data.characters && typeof data.characters === 'object') mem.characters = data.characters;
    if (Array.isArray(data.globalEvents)) mem.globalEvents = data.globalEvents;
    if (typeof data.globalSummary === 'string') mem.globalSummary = data.globalSummary;
    if (typeof data.mainlineSummary === 'string') mem.mainlineSummary = data.mainlineSummary;
    if (typeof data.worldview === 'string') mem.worldview = data.worldview;
    persist();
    return true;
}

function showTextDialog(title, text) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center';
    modal.innerHTML = `
        <div style="background:#1e1e1e;padding:16px;border-radius:8px;width:85%;max-width:640px">
            <div style="margin-bottom:8px;color:#eee;font-weight:bold">${escapeHtml(title)}</div>
            <textarea readonly style="width:100%;height:240px;background:#111;color:#ddd;border:1px solid #444">${escapeHtml(text)}</textarea>
            <div style="margin-top:8px;text-align:right"><button class="ntrmem-modal-close">关闭</button></div>
        </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.ntrmem-modal-close').onclick = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

function showImportDialog() {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center';
    modal.innerHTML = `
        <div style="background:#1e1e1e;padding:16px;border-radius:8px;width:85%;max-width:640px">
            <div style="margin-bottom:8px;color:#eee;font-weight:bold">粘贴导出的记忆 JSON：</div>
            <textarea id="ntrmem-import-text" style="width:100%;height:240px;background:#111;color:#ddd;border:1px solid #444"></textarea>
            <div style="margin-top:8px;text-align:right">
                <button class="ntrmem-modal-close">取消</button>
                <button id="ntrmem-import-ok">导入</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.ntrmem-modal-close').onclick = () => modal.remove();
    modal.querySelector('#ntrmem-import-ok').onclick = () => {
        const text = modal.querySelector('#ntrmem-import-text').value;
        modal.remove();
        try {
            if (importMemory(text)) {
                renderSettings();
                toastr?.success?.('记忆导入成功');
            } else {
                toastr?.error?.('导入失败：数据格式不对');
            }
        } catch (e) {
            toastr?.error?.('导入失败：JSON 解析错误');
        }
    };
}

function mountSettings() {
    const container = document.getElementById('extensions_settings');
    if (!container) return;
    if (document.getElementById('ntr-memory-settings')) return;
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
        pushMessage(messageId);
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
        const isAI = pushMessage(messageId);
        if (isAI) checkSummarize();
    });
    try { registerCommands(); } catch (e) { console.warn('[ntr-memory] 命令注册失败：', e); }
    try { mountSettings(); } catch (e) { console.warn('[ntr-memory] 设置面板挂载失败：', e); }
    console.log('[ntr-memory] 记忆核心已启动（按人分档 + 共有记忆）。');
}

if (document.readyState === 'complete') {
    init();
} else {
    window.addEventListener('load', init);
}
try {
    eventSource.on(event_types.APP_READY, init);
} catch (e) { /* 忽略 */ }
