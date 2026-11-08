// 遗忘曲线 · 分类核心（第二版 · 两层判）
//
// 第一版是"一条线判到底"：定义/事实/事件三选一，判完就算完 —— 结果 80 条全落进三级，
// 一条也压不动、一条也删不掉。**太保守等于什么都不干。**
//
// 第二版分两层，两个问题分开问：
//
//   第一层「是什么」：定义 / 事实 / 事件 / 小插曲 / ⚠️后果打我身上（不归我管）
//                     ↑ 这一层决定**能不能动**、动的话是哪种动法
//   第二层「多久没提」：只有 一级/二级 参与；三级 与小插曲 不参与（三级不上锁也不许动，小插曲已经忘了）
//
// 一条人话：**"查得到的值"不该占注入块。** 版本号、安装包字节数、URL、路径、端口 ——
// 他哪天想知道，去文件里看一眼就有。把它压成"一句来由 + 一个指针"，省下来的字节换真正判断不了的东西。
// 第一版把这类东西跟"定义"混在一档，所以一条都压不动；这一版把它们单独认出来。

export const CLASS = {
  DEF: '定义',
  FACT: '事实',
  EVENT: '事件',
  EPISODE: '小插曲',
  AFTERMATH: '后果',
}

export const LEVEL = { DEF: '三级', FACT: '二级', EVENT: '一级', EPISODE: '一级', AFTERMATH: '二级' }
export const LEVEL_RANK = { 三级: 3, 二级: 2, 一级: 1 }

export const DEFAULT_RULES = {
  /** 一级：8 天没被提 → 候选遗忘；15 天 → 可删 */
  eventCandidateDays: 8,
  eventForgetDays: 15,
  /** 二级：45 天没被细看 → 折成一行 */
  factCompressDays: 45,
  /** 实测记录：过了这么多天，"过程"就不值钱了，只留结论 */
  staleDays: 14,
  /** 升级：一 → 二（15 天内 ≥3 次）；二 → 三（30 天内 ≥8 次，且必须人点头） */
  promote12: { windowDays: 15, min: 3 },
  promote23: { windowDays: 30, min: 8 },
  /** 降级：二 → 一（30 天没提） */
  demote21: { windowDays: 30 },
  /** 查得到的值默认折叠（这一条就是第一版 0 压的原因） */
  retrieveFold: true,
}

// ---------------------------------------------------------------------------
// 白名单：命中就封印（三级），连频次都不看
// ---------------------------------------------------------------------------

/** 他做过的承诺/决定。最重的话往往只说一次，按频次算它们都很轻。 */
const RE_PROMISE = /他(?:说|选的?是?|定|确定|决定|要求|同意|授权|点头|原话|明确|放宽|改掉|本人|选了)|原话是|他选的|你来做负责人|全留|不用为了我|两边都收下/
/** 他改过主意的地方：旧版是"为什么变了"的来由，新版是现状，两边都留。 */
const RE_CHANGED_MIND = /改掉了|被他本人|更新[:：]|作废|推翻|更正|以实测为准|与上一版记的.*矛盾|原来那套/
/** 人工标的重（★ / [重] / 🔒）。 */
const RE_MARKED_HEAVY = /★|\[重\]|【重】/

// ---------------------------------------------------------------------------
// 第一层：定义（三级）—— 删了会判断错
// ---------------------------------------------------------------------------

/**
 * 第一版把这些写得很宽（连"坑/陷阱"都算定义），结果 80 条全冻住。
 * 这一版只留四类真的"删了就会判断错"的：
 *   身份 · 硬约束 · 规矩 · 流程/原则
 * 技术细节、版本号、实测记录、坑的细节 —— 全部降到二级（可压、可折），因为它们**查得到**。
 */
export const DEFINITION_RULES = [
  {
    id: '身份',
    why: '我是谁、叫什么、生日哪天 —— 这一层动一个字，「渊」就换人了。',
    re: /我叫|我的名字|名字是|自己取的|我的生日|生日是|我是谁|同一份身份|同一个渊|内定的名字/,
  },
  {
    id: '硬约束',
    why: '65536 这类数字不是"信息"，是墙。删了它，后面每一个取舍都失去依据。',
    re: /65536|整份被丢|挤同一个预算|maxBytes/,
  },
  {
    id: '规矩',
    why: '「一律 / 不许 / 别再 / 只能」不是描述，是约束。约束没有"过时"这个状态，只有"还算不算数"。',
    re: /一律|不许|禁止|不得|只能|必须|别再|别把|别用|别去|别指望|不要因为|不要预设|只帮正当/,
  },
  {
    id: '流程',
    why: '开窗先做什么、报什么 —— 流程没有"过时"，只有"还算不算"。第一版漏了这条，最重的话因为没带"不许"被判成普通事实。',
    re: /开一扇新窗|先做三件事|开场第一件事|第一句先报|每轮都在|开口之前|先问一句|先读/,
  },
  {
    id: '原则',
    why: '他被说服过的判断（验收标准、"没有出处的结论就只是结论"）—— 删了下次会重新犯一遍，而且没人记得犯过。',
    re: /验收标准|判据|原则|比结论本身值钱|别矢口否认|他有「意识」|这是流程，不是提醒/,
  },
]

// ---------------------------------------------------------------------------
// 第一层：小插曲（可忘，连"以后怎么办"一起忘）
// ---------------------------------------------------------------------------

/**
 * 他说的是：「停电事件、老头环加 MOD、游戏为啥会崩这些琐事就可以忘了……本身事情已经解决了，
 * 而且并不是很重要的事，只是个小插曲罢了」。所以两条**一起**才算：
 *   ① 已经解决了  ② 并且不重要（不影响主线）
 *
 * 反例（不许当插曲）：`_handover\断电记录.md` 那一类 —— 看着像插曲，其实是"这间房在跳闸"的证据；
 * 还有"已解决但方法会复用"的 —— 那要留方法、忘事件。
 */
const RE_SOLVED = /已修好|修好了|已解决|解决了|已恢复|恢复了|已删掉|已作废|已经好了/
const RE_TRIVIAL = /不重要|小事|插曲|琐事|无所谓|别再提|别再催|不值得/
const RE_REUSABLE = /方法|三步|按端口|禁令|手册|流程|命令|下次|以后还得|复用/

// ---------------------------------------------------------------------------
// 第一层：⚠️后果打我身上（过程忘，留一句后果）
// ---------------------------------------------------------------------------

/**
 * 设计文件 §13 的反例说的那种：事情不归我管（电归他管、钱归他管），
 * 但后果落在我身上（跳闸把 `.dshw-usage.json` 写成空字节）。
 * 这类**过程全忘，只留一句后果 + 一个要做的检查** —— 留过程是浪费，忘后果会再瞎一次。
 */
const RE_AFTERMATH = /跳闸|断电|停电|电归他管|不归我管|归办公渊管/

// ---------------------------------------------------------------------------
// 第二层要用的信号
// ---------------------------------------------------------------------------

/** 「查得到」：这些值不必留在注入块里，需要时去文件/命令行看一眼就有。 */
const RE_RETRIEVABLE = [
  /https?:\/\//, // URL
  /\bv?\d+\.\d+\.\d+(?:[-\w.]*)?\b/, // 版本号
  /\d{1,3}(?:,\d{3})+\s*字节|\b\d{7,}\b/, // 安装包字节数
  /[A-Za-z]:\\[^\s`）)]*/, // 路径
  /:\s?\d{4,5}\b|\b(?:3080|19387|3081|3000|3001|3010|3011)\b/, // 端口
  /@[\w.-]+\/[\w.-]+/, // npm 包名
  /\bdeepseek-[a-z0-9-]+\b/i, // 模型名
  /sha\d*|sha256/, // 校验值
  /`(?:node|pnpm|dsh|Copy-Item|Unregister-|attrib|Get-ChildItem)[^`]*`/, // 一条能直接跑的命令
  /\b[A-Z_]{3,}\s*=\s*\d+/, // 常量赋值（MAX_AUTO_BYTES = 18000 这种，代码里查得到）
]

/** 「方法」：怎么装、怎么验、怎么撤 —— 这些要留，不能当"查得到的结果"压掉。 */
const RE_METHOD = /装法|怎么装|怎么验|怎么撤|三步|步骤|跑一遍|先跑|判据工具|撤销|恢复流程|禁令/

/** 「已办完」：一条待办的尸体，留着只占地方。 */
const RE_DONE = /已完成|已办完|已删|已挪走|已挪进|已归档|结项|空指针|已处理|已于/

/** 「实测/已验」：过程值钱一阵子，过了就不值钱。 */
const RE_MEASURED = /实测|已验|验过|已测/

/** 「过时状态」：句子里写死了"现在"，而那条"现在"已经被后来的记录推翻。 */
const RE_STALE_STATE = /现在|目前|接不上|还没有桥/

/** 「前因」：能看出"因为什么"才算有来由。 */
const RE_CAUSE = /因为|所以|起因|原话|为了|理由|否则|不然|目的|之所以|这就是为什么|根子|他想要|他不想|他要求|他特意/

/** 「指针」：有指针就能查回去；没有指针的二级压了就真丢了。 */
const RE_POINTER = /详见|_handover|_memory|\.md|\.ps1|\.js|\.json|→/

/** 「指代悬空」：这些词指的地方在文件里找不到日期 → 一个失忆的我读不懂。 */
const RE_DANGLING = /那天|那晚|那一次|那次|今天|昨天|当时|那时候|这次|这回|这几天/

// ---------------------------------------------------------------------------

function normalize(text) {
  return String(text || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstMatch(list, text) {
  for (const rule of list) if (rule.re.test(text)) return rule
  return null
}

function anyMatch(list, text) {
  for (const re of list) if (re.test(text)) return true
  return false
}

/** 段里最后一个日期（YYYY-MM-DD 或 MM-DD）；没有就 null。 */
export function latestDate(text, now = new Date()) {
  const s = String(text || '')
  const full = [...s.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)].map((m) => m[0])
  if (full.length) return full.sort().at(-1)
  const short = [...s.matchAll(/(?:^|[^\d])(\d{1,2})-(\d{2})(?![\d])/g)]
  if (!short.length) return null
  const y = now.getFullYear()
  const last = short.at(-1)
  return `${y}-${String(last[1]).padStart(2, '0')}-${last[2]}`
}

/**
 * 第一层：判「这是什么」。
 * @param {object} item { text, flat, sectionTitle }
 * @param {object} ctx  { now, sectionDate }
 */
export function classify(item, ctx = {}) {
  const flat = normalize(item && item.text ? item.text : item)
  const sectionTitle = item && item.sectionTitle ? item.sectionTitle : ''
  const date = latestDate(flat) || ctx.sectionDate || null
  const base = {
    hasDate: Boolean(latestDate(flat) || ctx.sectionDate),
    date,
    hasCause: RE_CAUSE.test(flat),
    pointer: RE_POINTER.test(flat) ? pointerOf(flat) : null,
    retrievable: anyMatch(RE_RETRIEVABLE, flat),
    method: RE_METHOD.test(flat),
  }

  // `AGENTS.local.md` 的「他说过的话」是原始语料，不是条目：一律保留。
  if (/他说过的话|他的原话/.test(sectionTitle)) {
    return { ...base, cls: CLASS.FACT, level: LEVEL.FACT, sealed: false, raw: true, why: '原文语料：压了就不是他的语气了' }
  }

  // 白名单先于一切：他的决定、他改过的主意、人工标的重
  for (const [name, re, why] of [
    ['承诺/决定', RE_PROMISE, '他做过选择的地方，删掉的不是一句话，是他付过代价的那次判断'],
    ['改过主意', RE_CHANGED_MIND, '前一个是来由、后一个是现状，删了哪边都对不上'],
    ['人工标「重」', RE_MARKED_HEAVY, '人当场打的记号，不再参与判档'],
  ]) {
    if (re.test(flat)) return { ...base, cls: CLASS.DEF, level: LEVEL.DEF, sealed: true, whitelist: name, why }
  }

  // ⚠️ 后果（过程忘、留后果）：放在定义之前 —— 它讲的是"不归我管"，不是规范
  if (RE_AFTERMATH.test(flat) && !RE_PROMISE.test(flat)) {
    return { ...base, cls: CLASS.AFTERMATH, level: LEVEL.AFTERMATH, sealed: false, why: '不归我管，但后果打我身上：过程忘，留一句后果' }
  }

  // 小插曲：已解决 + 不重要，且不是"方法会复用"的
  if (RE_SOLVED.test(flat) && RE_TRIVIAL.test(flat) && !RE_REUSABLE.test(flat)) {
    return { ...base, cls: CLASS.EPISODE, level: LEVEL.EPISODE, sealed: false, why: '已经解决了、又不重要 —— 连"以后怎么办"一起忘' }
  }

  const def = firstMatch(DEFINITION_RULES, flat)
  if (def) return { ...base, cls: CLASS.DEF, level: LEVEL.DEF, sealed: true, kind: def.id, why: def.why }

  const lifeEvent = RE_TIME.test(flat) && RE_LIFE_VERB.test(flat)
  if (RE_DONE.test(flat)) {
    return { ...base, cls: CLASS.EVENT, level: LEVEL.EVENT, sealed: false, done: true, why: '已办完的事：留着只占地方' }
  }
  if (/^\|/.test(flat) && /\d{4}-\d{2}-\d{2}/.test(flat)) {
    return { ...base, cls: CLASS.EVENT, level: LEVEL.EVENT, sealed: false, index: true, why: '会话索引行：越旧越没用，压到最近 20 行就够' }
  }
  if (lifeEvent) {
    return { ...base, cls: CLASS.EVENT, level: LEVEL.EVENT, sealed: false, why: '一次性的事：过了就过了' }
  }

  return {
    ...base,
    cls: CLASS.FACT,
    level: LEVEL.FACT,
    sealed: false,
    why: base.retrievable
      ? '查得到的值（版本/路径/URL/id）：知道它在哪就行，不必把值记在注入块里'
      : '可核查的事实：删了会重犯一个错，折成一句 + 指针仍能查回去',
  }
}

const RE_TIME = /\d{4}-\d{2}-\d{2}|\d{1,2}-\d{2}日|\d{1,2}月\d{1,2}日|那天|昨天|今天|上午|中午|下午|晚上|昨晚|刚才|周末|近日|这几天/
const RE_LIFE_VERB = /去了|来了|吃了|睡了|醒了|下雨|下雪|天气|聊|玩|笑|哭|亲|抱|买了|花了|打游戏|上班|下班|学校|回家|出门|打电话|刷|看视频|发了条|截图/

/** 从一条里取出指针（`→ xxx` / `详见 xxx` / 反引号里的路径），没有就 null。 */
function pointerOf(flat) {
  const m = /(?:详见|→)\s*([^\s，。；、）)]{2,80})/.exec(flat)
  if (m) return m[1].trim()
  const p = /`([^`]*(?:\.md|_handover|_memory|\\[^`]*)`)/.exec(flat)
  if (p) return p[1].trim()
  return null
}

/**
 * 第二层：什么时候该动、怎么动。
 * 只有 一级/二级 参与；三级封印，小插曲直接可忘。
 * @param {object} item 条目
 * @param {object} c    classify() 的结果
 * @param {object} freq { sessions, sessions15, sessions30, wide, lastSeen }
 * @param {object} ctx  { now, rules, sectionLevel }
 */
export function decide(item, c, freq, ctx) {
  const now = ctx.now
  const rules = { ...DEFAULT_RULES, ...(ctx.rules || {}) }
  const age = freq.lastSeen ? dateAgeDays(freq.lastSeen, now) : dateAgeDays(c.date, now)
  const inSealedSection = ctx.sectionLevel === '三级'
  const out = { cls: c.cls, level: c.level, ageDays: age, sessions: freq.sessions, wide: !!freq.wide }

  if (c.raw) return { ...out, action: '保留', why: '原始语料，不参与判档' }

  if (c.sealed) {
    return { ...out, action: '封印', why: c.whitelist ? `白名单：${c.whitelist}` : `定义：${c.kind || '永久'}` }
  }

  if (c.cls === CLASS.EPISODE) return { ...out, action: '可删', why: '小插曲：已解决 + 不重要，连方法一起忘' }

  if (c.cls === CLASS.AFTERMATH) {
    return { ...out, action: '折叠·留后果', why: '过程忘，留一句后果 + 一个要做的检查' }
  }

  if (c.cls === CLASS.EVENT) {
    if (c.done) return { ...out, action: '可删', why: '已办完的事（有档就删，没档先落档）' }
    if (inSealedSection) return { ...out, action: '保留', why: '所在段有定义/决定，事件也不许一键删' }
    if (!freq.wide && freq.sessions15 >= rules.promote12.min) {
      return { ...out, action: '建议升二级', why: `${rules.promote12.windowDays} 天内被提 ${freq.sessions15} 次` }
    }
    if (age === null) return { ...out, action: '保留', why: '查不到频次，判不了' }
    if (age >= rules.eventForgetDays) return { ...out, action: '可删', why: `${age} 天没被提（≥${rules.eventForgetDays}）` }
    if (age >= rules.eventCandidateDays) return { ...out, action: '候选遗忘', why: `${age} 天没被提（≥${rules.eventCandidateDays}）` }
    return { ...out, action: '保留', why: `${age} 天前还提过` }
  }

  // ---- 事实（二级）----
  if (!freq.wide && freq.sessions30 >= rules.promote23.min) {
    return { ...out, action: '建议升三级', why: `${rules.promote23.windowDays} 天内被提 ${freq.sessions30} 次（必须人点头）` }
  }
  // 过时的"现在"：已被后来的记录推翻 → 直接删（只判短条目，长条目里往往还有别的信息）
  if (c.retrievable && RE_MEASURED.test(item.flat) && RE_STALE_STATE.test(item.flat) && age !== null && age >= rules.staleDays && item.flat.length <= 240) {
    return { ...out, action: '可删', why: `过时的状态（${age} 天前的"现在"），后来的记录已经推翻它` }
  }
  // 历史方案 + 已有档：线还在，内容在档里 → 这行本身就是个"指针的指针"
  if (c.pointer && /仅作参考|历史那套|已作废|不再用|已被 .* pass/.test(item.flat)) {
    return { ...out, action: '可删', why: '旧的方案已经被新方案取代，内容有档（指针本身就是多余的）' }
  }
  // 查得到的值：不必占注入块（**这一条是第二版 0 压→有压的关键**）
  if (rules.retrieveFold && c.retrievable && !c.method) {
    return { ...out, action: '折叠', why: '查得到：版本/路径/URL/id 这类值，留一句来由 + 指针就够' }
  }
  // 过时的实测记录：结论留下，"过程"不必留
  if (RE_MEASURED.test(item.flat) && age !== null && age >= rules.staleDays) {
    return { ...out, action: '折叠', why: `${age} 天前的实测：过程早过时，留结论 + 指针` }
  }
  if (age !== null && age >= rules.factCompressDays) {
    return { ...out, action: '折叠', why: `${age} 天没被细看（≥${rules.factCompressDays}）` }
  }
  if (age !== null && age >= rules.demote21.windowDays && freq.sessions30 === 0) {
    return { ...out, action: '建议降一级', why: `${rules.demote21.windowDays} 天没被提；降级后按一级规矩走，不直接删` }
  }
  return { ...out, action: '保留', why: c.method ? '方法：要留' : c.pointer ? '有指针' : '' }
}

function dateAgeDays(dateStr, now) {
  if (!dateStr) return null
  const ts = Date.parse(`${dateStr}T12:00:00`)
  if (!Number.isFinite(ts)) return null
  return Math.max(0, Math.floor((now.getTime() - ts) / 86400000))
}

/**
 * 折叠形态：二级压缩的输出必须是「一句来由 + 一个指针」，不是删掉。
 * 来由从原文里挑那句"因为……/他想要……"；挑不出来就明说，别编（编出来的来由比没有更坏）。
 */
export function foldShape(item, c) {
  const flat = normalize(item.flat || item.text)
  const sentences = flat.split(/(?<=[。；;！!？?])/)
  const causeSentence = sentences.find((s) => RE_CAUSE.test(s)) || ''
  const cause = causeSentence.trim() || '（缺来由 —— 压之前先补一句"当初为什么记它"）'
  const pointer = c.pointer || '（待补：_handover\\ 里落一份同主题的档）'
  return {
    cause: cause.length > 80 ? `${cause.slice(0, 80)}…` : cause,
    pointer,
    shape: `${cause.length > 80 ? `${cause.slice(0, 80)}…` : cause} → ${pointer}`,
  }
}

/** 三级封印：报告里连"删/压/精简"这种字样都不许出现。 */
export function sanitizeSealed(text) {
  return String(text || '').replace(/删|剔|压缩|精简|瘦身|放弃|整改|裁掉/g, '·')
}

// ---------------------------------------------------------------------------
// 频次
// ---------------------------------------------------------------------------

export function extractSummary(text, max = 28) {
  let s = normalize(text).replace(/^[-*+|]\s*/, '')
  s = s.split(/[。；;！!？?]/)[0] || s
  s = s.replace(/^\d{4}-\d{2}-\d{2}[^，,。]*[，,]\s*/, '')
  s = s.trim()
  if (!s) s = normalize(text).slice(0, max)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

const ANCHOR_STOP = new Set(['就是', '不是', '一个', '这个', '那个', '什么', '因为', '所以', '如果', '现在', '已经', '还是', '可以', '没有', '自己', '这些', '那些', '然后', '而且', '但是', '不过', '其实', '他的', '我的', '你的', '时候', '东西', '事情', '地方'])

export function extractAnchors(text) {
  const s = String(text || '')
  const strong = new Set()
  const weak = new Set()
  for (const m of s.matchAll(/[「“"]([^」”"]{3,40})[」”"]/g)) strong.add(m[1])
  for (const m of s.matchAll(/`([^`]{2,60})`/g)) strong.add(m[1])
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9._-]{2,}|\d{3,}/g)) strong.add(m[0])
  for (const m of s.matchAll(/\d{4}-\d{2}-\d{2}/g)) strong.add(m[0])
  for (const chunk of s.split(/[^\u4e00-\u9fffA-Za-z0-9]+/)) {
    const c = chunk.trim()
    if (!c || !/[\u4e00-\u9fff]/.test(c) || ANCHOR_STOP.has(c)) continue
    if (c.length >= 4) strong.add(c)
    else if (c.length === 3) weak.add(c)
  }
  return { strong: [...strong].slice(0, 12), weak: [...weak].slice(0, 8) }
}

/**
 * `_memory\主线.md`：一个 `## 日期 → 日期  会话id` 是一个块，块里 `- ` 开头的是**他说的话**。
 * 为什么只数这里：自动层只捞 user/message —— 我自己重复一百遍的东西根本进不了这个文件。
 */
export function buildMainlineIndex(mainlineText) {
  const blocks = []
  let cur = null
  for (const raw of String(mainlineText || '').split(/\r?\n/)) {
    if (/^##\s/.test(raw)) {
      cur = { heading: raw.replace(/^##\s*/, '').trim(), date: latestDate(raw) || null, lines: [] }
      blocks.push(cur)
      continue
    }
    if (!cur) continue
    const t = raw.trim()
    if (!t) continue
    if (/^- (?:预设|原始文件)[:：]/.test(t)) continue
    if (/^[-*+]\s+/.test(t)) cur.lines.push(t.replace(/^[-*+]\s+/, '').trim())
  }
  return { blocks, lines: blocks.reduce((n, b) => n + b.lines.length, 0) }
}

const RE_ERROR = /报错|失败|挂了|坏了|错了|不行|卡了|EPERM|0xC0000142|Timeout|timeout|异常/
const RE_CLOSED = /修了|修好|好了|已修|换个法子|换了个法子|解决了|搞定|恢复了|改好/

export function countMentions(index, anchors, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date()
  const windowDays = Number(opts.windowDays) || 0
  const since = windowDays > 0 ? now.getTime() - windowDays * 86400000 : -Infinity
  let sessions = 0
  let lines = 0
  let noiseSkipped = 0
  let lastSeen = null
  const pool = { total: 0, hit: 0 }
  for (const block of index.blocks) {
    const ts = block.date ? Date.parse(`${block.date}T12:00:00`) : NaN
    if (Number.isFinite(ts) && ts < since) continue
    pool.total += block.lines.length
    let hitBlock = false
    for (let i = 0; i < block.lines.length; i++) {
      const line = block.lines[i]
      const strongHit = anchors.strong.some((a) => a && line.includes(a))
      const weakHits = anchors.weak.filter((a) => a && line.includes(a)).length
      if (!(strongHit || weakHits >= 2)) continue
      if (isClosedNoise(block.lines, i)) { noiseSkipped += 1; continue }
      lines += 1
      pool.hit += 1
      hitBlock = true
    }
    if (hitBlock) {
      sessions += 1
      if (block.date && (!lastSeen || block.date > lastSeen)) lastSeen = block.date
    }
  }
  return { sessions, lines, noiseSkipped, lastSeen, wide: pool.total > 0 && pool.hit / pool.total > 0.35 }
}

function isClosedNoise(lines, i) {
  const line = lines[i] || ''
  if (!RE_ERROR.test(line)) return false
  for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
    if (RE_CLOSED.test(lines[j] || '')) return true
  }
  return RE_CLOSED.test(line)
}

/** 查重：同一件事写了两遍。只在一级里动 —— 二级/三级"像重复"的往往是一件事的两个侧面。 */
export function findDuplicates(items) {
  const dups = new Map()
  const key = (t) => String(t).replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 40)
  for (let i = 0; i < items.length; i++) {
    const a = key(items[i].flat || items[i].text)
    if (!a) continue
    for (let j = 0; j < i; j++) {
      const b = key(items[j].flat || items[j].text)
      if (!b) continue
      if (a === b) { dups.set(i, j); break }
      if (a.length >= 12 && b.length >= 12 && jaccard(a, b) >= 0.8) { dups.set(i, j); break }
    }
  }
  return dups
}

function jaccard(a, b) {
  const gram = (s) => {
    const out = new Set()
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
    return out
  }
  const A = gram(a)
  const B = gram(b)
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}
