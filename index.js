// 遗忘曲线（dsh-forgetting-curve）· 宿主半边 · 第二版
//
// 第一版：按"段"判，一条线分三级 → 跑出来 80 条三级、0 压、0 删。太保守，等于什么都不干。
// 第二版：**按组块（B1–B9）算，两层判** ——
//   第一层「是什么」：定义 / 事实 / 事件 / 小插曲 / ⚠️后果打我身上
//   第二层「多久没提」：只有 一级/二级 参与
//
// 关键改动（也是第一版 0 压的原因）：**"查得到的值"（版本号、安装包字节数、URL、路径、端口、id）
// 不再跟"定义"混在一档。** 它们单独认出来，折成「一句来由 + 一个指针」——
// 他哪天想知道，去文件/命令行看一眼就有；留在注入块里纯占地方。
//
// 它只管两份文件：`<工作区>\AGENTS.md` + `<工作区>\AGENTS.local.md`（挤同一个 65536 预算）。
// 绝不碰 `_handover\` / `_memory\`；写出去的东西（备份、月报、调配留痕）都收在 `_handover\_记忆备份\`。
//
// 0.4.0 加了两件事（都还在这份文件里，没有第二套逻辑）：
//   · 只读快照路由 `GET /dsh-forgetting-curve/snapshot` —— 设置页面板（client/index.js）读它。
//     另有一条 `POST /dsh-forgetting-curve/action`，只认 op = scan / report / backup，
//     **不接受任何路径类参数**（路径全由宿主按配置自己算）。
//   · 定时检查：`ctx.effect` 挂的 timer，判据复用 `shouldRun()`（85% 立刻跑 / 满 periodDays 跑），
//     默认提案模式 —— 跑完只写报告 + snapshot.json，**AGENTS.md / AGENTS.local.md 一个字节都不动**。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUDGET_BYTES,
  ALERT_BYTES,
  pct,
  padEndWidth,
  strWidth,
  readSources,
  splitSections,
  splitItems,
  blockOf,
  stripMark,
  assignBlocks,
  groupIntoBlocks,
  unmarkedSections,
} from './lib/measure.js'
import { BLOCKS, UNMARKED, LOCAL, LOCAL_QUOTA, QUOTA_TOTAL, blockMeta, planTransfers, appendTransferLog, TOLERANCE_PCT, toleranceOf, isOverLimit } from './lib/blocks.js'
import {
  CLASS,
  LEVEL,
  LEVEL_RANK,
  DEFAULT_RULES,
  classify,
  decide,
  foldShape,
  sanitizeSealed,
  extractSummary,
  extractAnchors,
  buildMainlineIndex,
  countMentions,
  findDuplicates,
  latestDate,
} from './lib/classify.js'
import { backupPair, restore, listBackups, todayStamp, backupRoot } from './lib/backup.js'

export const name = 'forgetting-curve'
export const NS = 'forgetting-curve'

/**
 * 依赖声明（2026-11-08 补）。
 *
 * 为什么必须写：**没有这一行，DSH 重启时这个插件会比 `webServer` 服务先 apply** ——
 * `ctx.get('webServer')` 拿到 undefined，路由整条不挂，面板就一直是 404/405。
 * 手动重载能好，是因为那时服务早就起来了（实测：重载立刻 200）。
 *
 * `dsh-meme` 就是这么写的：`export const inject = ['tools', 'webServer', ...]`。
 * 声明了以后 cordis 会等服务就绪再调 apply —— 比在 apply 里 setTimeout 重试可靠。
 *
 * `settings` 故意**不列进来**：它是可选的（拿不到就用文件配置），列进来会让插件被它卡住。
 */
export const inject = ['webServer']

/**
 * ⛔ 到 0.4.x 为止，这个插件**仍然不会改 `AGENTS.md` / `AGENTS.local.md`**。
 *
 * 2026-11-08 他提了两件事，都做了：
 *   ① 容差：块额度 ±10% 之内算正常波动，超出容差才标红（`lib/blocks.js` 的 `TOLERANCE_PCT`）；
 *   ② 模式开关：面板上能切 `proposal` / `auto` —— 这个常量换成了"看 cfg.mode"。
 *
 * **但 `auto` 现在也只是"到点自己跑 + 动手前自动备份"** —— "写"那一步的代码还没实现。
 * 这是故意的：`runOnce()` 里 `wantBackup` 之后只有报告 / 留痕 / snapshot，
 * **没有任何 `writeFileSync` 打向那两份信**。
 *
 * 等主会话跑通「备份 → 改 → 还原」一整圈，再补"写"，并把这段注释改成真的。
 */
function autoModeOf(cfg) {
  return Boolean(cfg) && cfg.mode === 'auto'
}

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version || '0.2.0'
  } catch {
    return '0.2.0'
  }
})()

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CONFIG_PATH = join(HOME, 'dsh-forgetting-curve.json')

const DEFAULT_CONFIG = {
  // 空 = 用进程当前目录。**开源版不预设任何个人路径**（原来写死了作者自己的工作区）。
  workspace: '',
  periodDays: 30,
  mode: 'proposal',
  backup: true,
  autoOnAlert: true,
  reportDir: '',
  mainline: '_memory\\主线.md',
  lastRunAt: null,
  rules: DEFAULT_RULES,
}

/**
 * 工作区到底在哪：配置里填了就用配置，没填就用 `process.cwd()`。
 * 所有读 `AGENTS.md` / 写备份的地方都必须走这里，别再直接 `cfg.workspace`。
 */
function rootOf(cfg) {
  const w = String((cfg && cfg.workspace) || '').trim()
  return w || process.cwd()
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export function loadConfig() {
  let saved = {}
  try { saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch { saved = {} }
  return { ...DEFAULT_CONFIG, ...saved, rules: { ...DEFAULT_RULES, ...(saved.rules || {}) } }
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch }
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
  } catch (error) {
    log(`配置写不进去（不影响本次报告）：${error.message}`)
    return next
  }
}

function log(msg) {
  try { console.log(`[遗忘曲线] ${msg}`) } catch {}
}

// ---------------------------------------------------------------------------
// 分析
// ---------------------------------------------------------------------------

/** 段标题里带日期的，当成这一段的"日期上下文"（写"那天"的时候，失忆的我也能对上哪天）。 */
function sectionDateOf(title) {
  return latestDate(title) || null
}

/**
 * 跑一遍：读 → 归块 → 切条目 → 第一层判是什么 → 数频次 → 第二层判动不动。
 * 纯函数，不写任何文件。
 */
export function analyze(opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.cfg || {}) }
  const root = opts.root || rootOf(cfg)
  const now = opts.now ? new Date(opts.now) : new Date()
  const sources = readSources(root)
  if (!sources.files.length) throw new Error(`读不到源文件：${root}`)

  const mainline = readMainline(root, cfg)
  const index = mainline.text ? buildMainlineIndex(mainline.text) : { blocks: [], lines: 0 }

  const sections = []
  const items = []
  for (const file of sources.files) {
    for (const section of splitSections(file.text)) {
      sections.push({ ...section, file: file.name, items: [], block: null })
    }
  }

  // 组块只按 `AGENTS.md` 分（`AGENTS.local.md` 是自动层，独立一行，不拆块）。
  // h3 没打块标时跟最近的 `[Bn]` h2 走；h2 没打标才是真没分类（进 B0）。
  const mdSections = sections.filter((s) => s.file === 'AGENTS.md')
  assignBlocks(mdSections)
  for (const s of sections) if (s.file !== 'AGENTS.md') s.block = LOCAL.id

  for (const seg of sections) {
    seg.sectionDate = sectionDateOf(seg.title)
    // 标题就说"已定 / 别再重新讨论"的段：整段封印（决定是拿来遵守的，不是拿来复核的）
    seg.sealedTitle = /已定|定的事|别再重新讨论|决定/.test(seg.title)
    for (const raw of splitItems(seg)) {
      const item = { ...raw, file: seg.file, section: seg.index, sectionTitle: seg.title, block: seg.block }
      const c = classify(item, { now, sectionDate: seg.sectionDate })
      if (seg.sealedTitle && !c.raw) Object.assign(c, { cls: CLASS.DEF, level: LEVEL.DEF, sealed: true, why: '标题：这条已定，别再重新讨论' })
      const anchors = extractAnchors(item.text)
      seg.items.push({ ...item, ...c, anchors, summary: extractSummary(item.text) })
    }
    // ⚠️ 这段的"档"存在 `tier` 上，**绝不能写回 `seg.level`**：
    //    `level` 是标题级别（h2=2 / h3=3），写回同一个字段以后，
    //    "h3 没打块标就跟母块走"那个判断就永远不成立 —— 这就是 h3 掉进 B0、B1 少算 4.4 KB 的真凶。
    seg.tier = seg.items.reduce((top, it) => (LEVEL_RANK[it.level] > LEVEL_RANK[top] ? it.level : top), '一级')
    seg.counts = countLevels(seg.items)
    for (const row of seg.items) {
      const f = frequency(index, row.anchors, now, cfg.rules)
      const d = decide(row, row, f, { now, rules: cfg.rules, sectionLevel: seg.tier })
      Object.assign(row, d, { freq: f, sectionLevel: seg.tier })
      items.push(row)
    }
  }

  // 查重：同一件事写了两遍。只在一级/小插曲上动手（二级/三级"像重复"的往往是一件事的两侧面）。
  const dups = findDuplicates(items)
  for (const [i, j] of dups) {
    const a = items[i]
    if (![CLASS.EVENT, CLASS.EPISODE].includes(a.cls)) continue
    if (a.sectionLevel === '三级') continue
    Object.assign(a, { action: '可删', why: `与第 ${j + 1} 条重复（"${trunc(a.summary, 16)}"）`, duplicateOf: j + 1 })
  }

  // 块用量（只算 AGENTS.md 的段；按 B1–B9 排，B0 垫底）
  const blocks = groupIntoBlocks(mdSections, (id) => blockMeta(id), UNMARKED).sort((x, y) => {
    if (x.id === UNMARKED.id) return 1
    if (y.id === UNMARKED.id) return -1
    return x.id.localeCompare(y.id)
  })
  for (const b of blocks) {
    b.items = items.filter((it) => it.block === b.id)
    b.counts = countLevels(b.items)
    b.fold = b.items.filter((it) => it.action === '折叠' || it.action === '折叠·留后果')
    b.remove = b.items.filter((it) => it.action === '可删')
    b.sealed = b.items.filter((it) => it.action === '封印')
    b.over = b.quota > 0 ? Math.max(0, b.bytes - b.quota) : 0
    b.spare = b.quota > 0 ? Math.max(0, b.quota - b.bytes) : 0
  }

  // `AGENTS.local.md`：自动层，独立一行（**不算"没打块标"**，本来就不该拆块）。
  const localSections = sections.filter((s) => s.file === 'AGENTS.local.md')
  const localBytes = sources.files.filter((f) => f.name === 'AGENTS.local.md').reduce((n, f) => n + f.bytes, 0)
  const localItems = items.filter((it) => it.block === LOCAL.id)
  const localBlock = localSections.length
    ? { id: LOCAL.id, name: LOCAL.name, quota: LOCAL_QUOTA, bytes: localBytes, sections: localSections, items: localItems, counts: countLevels(localItems), fold: [], remove: [], sealed: [], auto: true }
    : null
  const agentsBytes = sources.files.filter((f) => f.name === 'AGENTS.md').reduce((n, f) => n + f.bytes, 0)

  const usage = blocks.filter((b) => b.quota > 0).map((b) => ({ id: b.id, name: b.name, bytes: b.bytes, quota: b.quota }))
  const transfers = planTransfers(usage)

  const sealed = items.filter((it) => it.action === '封印')
  const foldable = items.filter((it) => it.action === '折叠' || it.action === '折叠·留后果')
  const deletable = items.filter((it) => it.action === '可删')
  const candidates = items.filter((it) => it.action === '候选遗忘')
  const noCause = items.filter((it) => !it.raw && !it.hasCause && !it.pointer && it.action !== '封印')
  const dangling = items.filter((it) => !it.raw && !it.hasDate && !it.pointer && /那天|那晚|那一次|那次|今天|昨天|当时|那时候|这次|这回/.test(it.flat) && (/那天|那晚|那一次|那次|今天|昨天|当时|那时候/.test(it.flat)))

  const foldSaving = foldable.reduce((n, it) => n + Math.max(0, it.bytes - 90), 0) // 折叠后按 90 B 估（来由 + 指针）
  const deletedBytes = deletable.reduce((n, it) => n + it.bytes, 0)
  const afterBytes = Math.max(0, sources.total - foldSaving - deletedBytes)

  return {
    now, root, cfg, sources, mainline, index, sections, items, blocks, transfers,
    agentsBytes, localBlock,
    sealed, foldable, deletable, candidates, noCause, dangling,
    foldSaving, deletedBytes, afterBytes,
    counts: countLevels(items),
    unmarked: unmarkedSections(mdSections),
  }
}

function frequency(index, anchors, now, rules) {
  if (!index.blocks.length) return { sessions: 0, sessions15: 0, sessions30: 0, wide: false, lastSeen: null }
  const all = countMentions(index, anchors, { now, windowDays: 0 })
  const f15 = countMentions(index, anchors, { now, windowDays: rules.promote12.windowDays })
  const f30 = countMentions(index, anchors, { now, windowDays: rules.promote23.windowDays })
  return { sessions: all.sessions, lastSeen: all.lastSeen, sessions15: f15.sessions, sessions30: f30.sessions, wide: all.wide || f15.wide || f30.wide }
}

function countLevels(list) {
  return list.reduce((acc, it) => {
    acc[it.level] = (acc[it.level] || 0) + 1
    if (it.cls === CLASS.EPISODE) acc.小插曲 += 1
    if (it.cls === CLASS.AFTERMATH) acc.后果 += 1
    return acc
  }, { 三级: 0, 二级: 0, 一级: 0, 小插曲: 0, 后果: 0 })
}

function readMainline(root, cfg) {
  const path = join(root, cfg.mainline || DEFAULT_CONFIG.mainline)
  try {
    return { path, text: readFileSync(path, 'utf8') }
  } catch (error) {
    return { path, text: null, error: error.message }
  }
}

// ---------------------------------------------------------------------------
// 月报
// ---------------------------------------------------------------------------

function nf(n) {
  return Number(n || 0).toLocaleString('en-US')
}

function strW(s) {
  return strWidth(String(s))
}

function trunc(text, width) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (strW(s) <= width) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = strW(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

/** 报告里的「段」= 一条记忆（组块里的一个格子）。 */
export function renderReport(a) {
  const L = []
  const stamp = todayStamp(a.now)
  const total = a.sources.total
  L.push(`${stamp} 遗忘报告（第二版 · 组块折叠）`)
  L.push('')
  L.push(`总量       ${nf(total)} B → 预计 ${nf(a.afterBytes)} B（${pct(total)}% → ${pct(a.afterBytes)}%）　额度 ${nf(QUOTA_TOTAL)} B（${pct(QUOTA_TOTAL)}%）`)
  L.push(`位置       距 85% 触底线（${nf(ALERT_BYTES)} B）${total >= ALERT_BYTES ? '**已经踩线，立刻跑**' : `还有 ${nf(ALERT_BYTES - total)} B`}`)
  L.push(`结构       ${a.blocks.length} 块${a.unmarked.length ? `（其中 ${a.unmarked.length} 段没打块标）` : ''} · 段 ${a.sections.length} · 条目 ${a.items.length}`)
  L.push(`判层       三级 ${a.counts.三级} · 二级 ${a.counts.二级} · 一级 ${a.counts.一级} · 小插曲 ${a.counts.小插曲} · 后果 ${a.counts.后果}`)
  L.push('')

  // ---- 组块用量 ----
  L.push('组块用量')
  const wName = 16
  L.push(`  ${padEndWidth('块', 4)}${padEndWidth('叫什么', wName)}${'用量'.padStart(8)}  ${'额度'.padStart(7)}  ${'差'.padStart(8)}   三/二/一   折/删`)
  for (const b of a.blocks) {
    const diff = b.quota > 0 ? b.bytes - b.quota : null
    const diffText = diff === null ? '—' : diff > 0 ? `超 ${nf(diff)}` : `余 ${nf(-diff)}`
    L.push(
      `  ${padEndWidth(b.id, 4)}${padEndWidth(trunc(b.name, wName), wName)}${nf(b.bytes).padStart(8)}  ${(b.quota ? nf(b.quota) : '—').padStart(7)}  ${diffText.padStart(8)}   ` +
        `${b.counts.三级}/${b.counts.二级}/${b.counts.一级}   ${b.fold.length}/${b.remove.length}`,
    )
  }
  L.push(`  ${padEndWidth('—', 4)}${padEndWidth('AGENTS.md', wName)}${nf(a.agentsBytes).padStart(8)}  ${nf(BLOCKS.reduce((n, b) => n + b.quota, 0)).padStart(7)}  ${`余 ${nf(BLOCKS.reduce((n, b) => n + b.quota, 0) - a.agentsBytes)}`.padStart(8)}`)
  if (a.localBlock) {
    const lb = a.localBlock
    L.push(
      `  ${padEndWidth('—', 4)}${padEndWidth(trunc(lb.name, wName), wName)}${nf(lb.bytes).padStart(8)}  ${nf(LOCAL_QUOTA).padStart(7)}  ${`余 ${nf(LOCAL_QUOTA - lb.bytes)}`.padStart(8)}   ` +
        `${lb.counts.三级}/${lb.counts.二级}/${lb.counts.一级}   —　不拆块，正常`,
    )
  }
  if (a.unmarked.length) {
    L.push('')
    L.push(`⚠️ AGENTS.md 里 ${a.unmarked.length} 段没打块标（h2 没标才算；h3 已跟母块走）：`)
    for (const s of a.unmarked) L.push(`   · ${s.file} L${s.lineStart}-${s.lineEnd}  ${trunc(stripMark(s.title), 30)}  ${nf(s.bytes)} B`)
  }

  // ---- 跨块调配 ----
  L.push('')
  if (a.transfers.length) {
    L.push('跨块调配（允许，但留痕）')
    for (const t of a.transfers) L.push(`  ${t.from} → ${t.to}  ${nf(t.bytes)} B　（${t.why}）`)
    L.push('  留痕：_handover\\_记忆备份\\_报告\\调配留痕.jsonl')
  } else {
    L.push('跨块调配（允许，但留痕）　—— 没有块超额度，不用挪。')
  }

  // ---- 建议折叠 ----
  L.push('')
  L.push(`建议折叠 ${a.foldable.length} 条（折叠成「一句来由 + 指针」，约省 ${nf(a.foldSaving)} B）`)
  let i = 0
  for (const it of a.foldable) {
    i += 1
    const shape = foldShape(it, it)
    L.push(`  ${String(i).padStart(2)}. [${it.block}] ${trunc(it.summary, 40)}  ${nf(it.bytes)} B　— ${it.why}`)
    L.push(`      ${it.action === '折叠·留后果' ? '留一句后果' : '折叠后'}：${trunc(shape.shape, 56)}`)
  }
  if (!a.foldable.length) L.push('  （0 条 —— 看下面「为什么没有」）')

  // ---- 建议删 ----
  L.push('')
  L.push(`建议删 ${a.deletable.length} 条（约省 ${nf(a.deletedBytes)} B）`)
  let j = 0
  for (const it of a.deletable) {
    j += 1
    L.push(`  ${String(j).padStart(2)}. [${it.block}] ${trunc(it.summary, 44)}  ${nf(it.bytes)} B　— ${it.why}`)
  }
  if (!a.deletable.length) L.push('  （0 条）')

  // ---- 候选遗忘 ----
  if (a.candidates.length) {
    L.push('')
    L.push(`候选遗忘 ${a.candidates.length} 条（先挂着，下次还没被提就进"可删"）`)
    for (const it of a.candidates) L.push(`  · [${it.block}] ${trunc(it.summary, 44)}  ${it.ageDays} 天`)
  }

  // ---- 没来由 ----
  L.push('')
  L.push(`没来由 ${a.noCause.length} 条（说不出"因为什么"，也没有指针可查 —— 补这一栏比删十条都值）`)
  for (const it of a.noCause) L.push(`  · [${it.block}] ${trunc(it.summary, 46)}  ${nf(it.bytes)} B`)

  // ---- 读者看不懂 ----
  L.push('')
  L.push(`读者看不懂"哪天" ${a.dangling.length} 条（指代悬空：写"那天/今天"，可文件里找不到那一天）`)
  for (const it of a.dangling) L.push(`  · [${it.block}] ${trunc(it.summary, 46)}  ${nf(it.bytes)} B`)

  // ---- 三级 ----
  L.push('')
  L.push(`三级 ${a.sealed.length} 条（一个字没动 —— 本报告不对它提任何改动）`)
  L.push(`  ${sanitizeSealed('（这层只报数量，不参与任何取舍。）')}`)

  // ---- 升降级 ----
  const p23 = a.items.filter((it) => it.action === '建议升三级')
  const p12 = a.items.filter((it) => it.action === '建议升二级')
  const down = a.items.filter((it) => it.action === '建议降一级')
  if (p23.length || p12.length || down.length) {
    L.push('')
    L.push('升降级建议')
    for (const it of p23) L.push(`  ↑ [${it.block}] 二级→三级（必须人点头）  ${trunc(it.summary, 38)}　${it.why}`)
    for (const it of p12) L.push(`  ↑ [${it.block}] 一级→二级  ${trunc(it.summary, 38)}　${it.why}`)
    for (const it of down) L.push(`  ↓ [${it.block}] 二级→一级（不直接删）  ${trunc(it.summary, 38)}　${it.why}`)
  }

  // ---- 数据质量 ----
  L.push('')
  L.push(`频次：主线 ${nf(a.index.blocks.length)} 个会话块 / ${nf(a.index.lines)} 句他说的话${a.mainline.text ? '' : '（⚠️ 读不到主线，这次没数频次）'}`)
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// 跑一轮
// ---------------------------------------------------------------------------

function reportDirFor(cfg, root) {
  return cfg.reportDir ? String(cfg.reportDir) : join(backupRoot(root), '_报告')
}

export function runOnce(opts = {}) {
  const cfg = { ...loadConfig(), ...(opts.cfg || {}) }
  const now = opts.now ? new Date(opts.now) : new Date()
  const a = analyze({ cfg, now, root: opts.root || rootOf(cfg) })
  const report = renderReport(a)
  const out = { report, analysis: a, reportPath: null, transferLog: null, snapshotPath: null, backup: null }

  // 自动模式：到点就跑（定时器那边判），动手前先备份。
  // 注意这里**只备份**，不改信 —— 见上面 autoModeOf() 的注释。
  const wantBackup = autoModeOf(cfg) && (a.foldable.length || a.deletable.length)
  if (wantBackup && cfg.backup !== false) out.backup = backupPair(a.root, { now, reason: '自动模式动手前' })

  try {
    const dir = reportDirFor(cfg, a.root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${todayStamp(now)}-遗忘报告.md`), `${report}\n`, 'utf8')
    out.reportPath = join(dir, `${todayStamp(now)}-遗忘报告.md`)
    out.transferLog = appendTransferLog(dir, a.transfers.map((t) => ({ kind: '跨块调配提案', ...t })), now)
    // 面板数据的落盘副本：路由没挂上（旧宿主 / 端口没起）时，人可以直接看这个文件。
    // 跟路由返回的是同一个 buildSnapshot()，不会两套数字。
    out.snapshotPath = join(dir, 'snapshot.json')
    writeFileSync(out.snapshotPath, `${JSON.stringify(buildSnapshot(a, { reportPath: out.reportPath, now }), null, 2)}\n`, 'utf8')
  } catch (error) {
    log(`月报没写进盘（不影响 stdout）：${error.message}`)
  }

  saveConfig({ lastRunAt: now.toISOString() })
  return out
}

export function shouldRun(sources, cfg, now = new Date()) {
  if (cfg.autoOnAlert !== false && sources.total >= ALERT_BYTES) return { run: true, why: `注入块 ${nf(sources.total)} B ≥ 85%` }
  if (!cfg.lastRunAt) return { run: true, why: '从没跑过' }
  const days = Math.floor((now.getTime() - new Date(cfg.lastRunAt).getTime()) / 86400000)
  const period = Number(cfg.periodDays) || 30
  return days >= period ? { run: true, why: `距上次 ${days} 天 ≥ ${period} 天` } : { run: false, why: `距上次 ${days} 天 / ${period} 天` }
}

// ---------------------------------------------------------------------------
// 只读快照（第一件：面板拿真数据）
// ---------------------------------------------------------------------------
//
// 数据怎么从宿主到浏览器 —— 2026-11-07 用 cordis_inspect_query 查到两条 Service，没猜：
//
//   ① `webServer`（Host Service，`ctx.get("webServer")`）
//      `register(route: WebRoute): () => void`
//      `WebRoute = { kind: 'exact' | 'prefix', path: string,
//                     handler(req: IncomingMessage, res: ServerResponse) }`
//      返回 disposer —— 所以挂路由必须走 `ctx.effect`，否则热重载时同一进程第二次 apply
//      会撞 duplicate (kind,path)。dsh-meme 用的就是这一套（`kind:'exact'` + `/dsh-memes-api`）。
//
//   ② `timer`（Host Service）
//      `interval(callback, delay): () => void` / `timeout(callback, delay): () => void`
//      两个都返回 disposer，且随当前 fiber 一起销毁。
//
// 两条路由，边界故意不一样：
//
//   GET  /dsh-forgetting-curve/snapshot
//        **纯只读**：只跑 analyze()（纯函数，一个字节都不写盘），
//        **不读查询串、不接受任何参数**，返回下面这份 JSON。
//
//   POST /dsh-forgetting-curve/action
//        面板三个按钮（scan / report / backup）。
//        只认 `op` 一个字段，且必须在白名单里；带了别的键一律 400 ——
//        **没有任何参数能指定"写哪个文件"**，所有路径都由宿主按配置自己算。
//
// 另外每跑一轮会往报告目录多写一份 `snapshot.json`：路由万一没挂上（旧宿主 / 端口没起），
// 面板读不到时，人还能直接去文件里看同一份数据。
// ---------------------------------------------------------------------------

const ROUTE_PREFIX = '/dsh-forgetting-curve'
const SNAPSHOT_PATH = `${ROUTE_PREFIX}/snapshot`
const ACTION_PATH = `${ROUTE_PREFIX}/action`

/** 面板能触发的操作 —— 只有这些，别的一律拒。 */
const ACTION_OPS = ['scan', 'report', 'backup', 'setMode', 'items', 'apply', 'restore']

/**
 * 明确拒绝的请求体字段。
 * 这不是"忽略"，是**显式报错**：让"我传个 path 试试"当场撞墙，而不是被静默吞掉。
 */
const FORBIDDEN_ACTION_KEYS = [
  'path', 'paths', 'file', 'files', 'filename', 'dir', 'dirs', 'directory',
  'root', 'reportDir', 'target', 'dest', 'content', 'text', 'workspace', 'cmd', 'command',
]

/** 一个组块 → 面板的一行。字段名按面板要的来，别让它自己算。 */
function blockRow(b) {
  // 差 = 用量 − 额度。quota 是 0 的块（B0 未打块标）没有额度可减，给 null，别编个 0 骗人。
  const diff = b.quota > 0 ? b.bytes - b.quota : null
  return {
    id: b.id,
    name: b.name,
    bytes: b.bytes,
    quota: b.quota,
    diff,
    // 容差（2026-11-08）：±10% 之内算正常波动，超出才叫"超"。
    // 面板拿这两个字段判断标不标红，不再自己拿 diff>0 当超。
    tolerance: b.quota > 0 ? toleranceOf(b.quota) : null,
    overLimit: isOverLimit(b.bytes, b.quota),
    tiers: { 3: b.counts.三级, 2: b.counts.二级, 1: b.counts.一级 },
    episodes: b.counts.小插曲,
    aftermath: b.counts.后果,
    fold: (b.fold || []).length,
    remove: (b.remove || []).length,
    sealed: (b.sealed || []).length,
    auto: Boolean(b.auto),
  }
}

/**
 * 今天那份报告在不在。
 *
 * 为什么要查盘而不是记变量：面板三个按钮都会回一份新快照，
 * 要是只有"出报告"那条带 reportPath，"备份"一按脚注上的路径就没了 —— 看着像文件被删了。
 * 报告文件名是 `YYYY-MM-DD-遗忘报告.md`，所以"今天那份在不在"是个能直接查的事实。
 */
function todayReportPath(cfg, root, now) {
  try {
    const path = join(reportDirFor(cfg, root), `${todayStamp(now)}-遗忘报告.md`)
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

/**
 * analyze() 的结果 → 给浏览器的只读 JSON。**纯函数**（除了上面那一次 existsSync 的查询，
 * 不写盘、不改任何东西）。
 *
 * 这是"唯一一份"面板数据：路由、静态 snapshot.json、将来的任何消费者都从这里出，
 * 免得面板和报告各算一套、数字对不上。
 */
export function buildSnapshot(a, extra = {}) {
  const cfg = a.cfg || {}
  const total = a.sources.total
  const nowDate = extra.now ? new Date(extra.now) : new Date()
  const generatedAt = nowDate.toISOString()
  const reportPath = extra.reportPath || todayReportPath(cfg, a.root, nowDate)

  const blocks = a.blocks.map(blockRow)
  if (a.localBlock) blocks.push(blockRow(a.localBlock))

  return {
    schema: 1,
    plugin: 'dsh-forgetting-curve',
    version: PLUGIN_VERSION,
    workspace: a.root,

    // 主数字（面板标题那一行就用这三个）
    totalBytes: total,
    limitBytes: BUDGET_BYTES,
    ratio: Math.round((total / BUDGET_BYTES) * 1000) / 1000,

    // 红线与余量（85% = ALERT_BYTES，定时器也看这个数）
    alertBytes: ALERT_BYTES,
    alert: total >= ALERT_BYTES,
    headroomBytes: BUDGET_BYTES - total,
    afterBytes: a.afterBytes,

    blocks,

    // 九块之外的两行说明：没打块标 / 自动层
    local: a.localBlock ? blockRow(a.localBlock) : null,

    suggestions: {
      fold: a.foldable.length,
      remove: a.deletable.length,
      foldBytes: a.foldSaving,
      removeBytes: a.deletedBytes,
      candidates: a.candidates.length,
      sealed: a.sealed.length,
      noCause: a.noCause.length,
      dangling: a.dangling.length,
    },

    counts: a.counts,
    structure: {
      blocks: a.blocks.length,
      sections: a.sections.length,
      items: a.items.length,
      unmarked: a.unmarked.length,
    },
    transfers: a.transfers.map((t) => ({ from: t.from, to: t.to, bytes: t.bytes, why: t.why })),

    // 0.4.x：mode 可切（proposal / auto），但 auto 也**不会改信** —— 写的那一步没实现。
    // writeEnabled 现在表示"当前是不是自动模式"，面板用它画那个标签。
    mode: cfg.mode || 'proposal',
    writeEnabled: autoModeOf(cfg),
    periodDays: Number(cfg.periodDays) || 30,

    lastRunAt: cfg.lastRunAt || null,
    reportPath,
    generatedAt,
  }
}

/** 现算一份快照（GET 路由用）。不写盘 —— 所以这个路由可以挂着随便调。 */
export function snapshotNow(opts = {}) {
  const cfg = { ...loadConfig(), ...(opts.cfg || {}) }
  const now = opts.now ? new Date(opts.now) : new Date()
  const a = analyze({ cfg, now, root: opts.root || rootOf(cfg) })
  return buildSnapshot(a, { now })
}

// ---------------------------------------------------------------------------
// 路由：把手写进 res（host 侧）
// ---------------------------------------------------------------------------

function jsonResponse(res, obj, status = 200) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error(`请求体过大（>${maxBytes} B）`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/** 同源检查：浏览器跨站 POST（CSRF）一律 403；没有 Origin 的本地脚本放行。 */
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === String(req.headers.host || '') } catch { return false }
}

/**
 * 参数错（客户端传错了）→ 标 400，别混成 500。
 * 2026-11-08 回归测试发现：`op=items&kind=whatever` 原来报 500，看着像宿主崩了，
 * 其实是调用方传错 —— 状态码得分清楚。
 */
function badRequest(message) {
  const err = new Error(message)
  err.status = 400
  throw err
}

/** 面板按钮的宿主实现。**一次实现**，路由和命令行都调它，别写两份。 */
export function runAction(op, cfg, now = new Date(), extra = {}) {
  const root = rootOf(cfg)
  if (!ACTION_OPS.includes(op)) badRequest(`未知操作：${op}`)

  // 2026-11-08 他提的：「只读提案模式」少一个可选选项。
  // 切模式只是改配置（~/.dsh/dsh-forgetting-curve.json），不碰 AGENTS.md。
  if (op === 'setMode') {
    const next = String((extra && extra.mode) || '').trim()
    if (next !== 'proposal' && next !== 'auto') {
      badRequest(`mode 只能是 proposal / auto，收到「${next || '(空)'}」`)
    }
    saveConfig({ mode: next })
    const after = { ...loadConfig() }
    return {
      ok: true,
      op,
      mode: after.mode,
      message: next === 'auto'
        ? '已切到自动模式：到点或踩 85% 自己跑，并在动手前自动备份。仍然不会改 AGENTS.md。'
        : '已切回只读·提案模式：只出提案，不写任何文件。',
      snapshot: snapshotNow({ cfg: after, now, root }),
    }
  }

  // 2026-11-08 他提的：「光有统计，没给选项去删减和更改」。
  // 这一条只**列**候选（完整原文），不动任何文件 —— 让面板能勾。
  if (op === 'items') {
    const kind = String((extra && extra.kind) || '').trim()
    if (kind !== 'fold' && kind !== 'remove') {
      badRequest(`kind 只能是 fold / remove，收到「${kind || '(空)'}」`)
    }
    const a = analyze({ cfg, now, root })
    const src = kind === 'fold' ? a.foldable : a.deletable
    const list = src.map((it, i) => {
      const text = String(it.text || '').trim()
      const shape = (kind === 'fold' && typeof foldShape === 'function') ? (foldShape(it, it) || {}) : {}
      const lines = text.split('\n').length
      return {
        n: i + 1,
        // 定位：起始行 + 占几行。**改文件就靠这两个数**（从后往前删，行号才不飘）。
        line: Number(it.line) || 0,
        lines,
        file: it.file || 'AGENTS.md',
        block: it.block || 'B0',
        section: it.sectionTitle || '',
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        why: it.why || '',
        after: String(shape.shape || '').trim(),
        // 这条能不能安全折叠：`foldShape` 对「缺来由」的条目返回的是待办提示，不是正文。
        // 面板拿这个字段把不能折的标灰（别让人勾了才发现被跳过）。
        foldable: !(String(shape.shape || '').trim().startsWith('（缺来由') || String(shape.shape || '').includes('压之前先补一句')),
        level: it.level || '',
        cls: it.cls || '',
      }
    })
    return {
      ok: true,
      op,
      kind,
      total: list.length,
      items: list,
      snapshot: buildSnapshot(a, { now }),
    }
  }

  // 2026-11-08 他提的完整闭环：「勾选完要点一下确认键才删掉，删完刷新能看见，
  // 误删了要知道去哪查、怎么恢复」。**这是本插件唯一会改 AGENTS.md 的操作。**
  //
  // 所以顺序是死的：先备份 → 备份不成功就绝不动手 → 改完留痕（改了什么/备份在哪/怎么恢复）。
  // 参数类错误一律 400（`badRequest`），服务端真出问题才 500。
  if (op === 'apply') {
    const kind = String((extra && extra.kind) || '').trim()
    if (kind !== 'fold' && kind !== 'remove') badRequest(`kind 只能是 fold / remove，收到「${kind || '(空)'}」`)
    const picks = Array.isArray(extra && extra.picks)
      ? extra.picks.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
      : []
    if (!picks.length) badRequest('没有勾选任何条目')

    const a = analyze({ cfg, now, root })
    const src = kind === 'fold' ? a.foldable : a.deletable
    // 带上序号，好和他的手写摘要对上（2026-11-08：折叠必须由人给一句"留成什么"）。
    const targets = picks
      .map((n) => (src[n - 1] ? Object.assign({}, src[n - 1], { __n: n }) : null))
      .filter(Boolean)
    if (targets.length !== picks.length) {
      badRequest('有勾选的编号对不上（可能刚重新扫描过，序号变了）—— 收起清单、重新点「看候选」再勾一次')
    }
    const summaries = (extra && extra.summaries) || {}

    // 只允许动 AGENTS.md。AGENTS.local.md 是自动层，不归这个插件管。
    for (const t of targets) {
      if ((t.file || 'AGENTS.md') !== 'AGENTS.md') {
        badRequest(`只允许改 AGENTS.md；这一条在「${t.file}」里，跳过整批`)
      }
    }

    // ① 先备份。备份不成功就绝不动手。
    let backup = null
    try {
      backup = backupPair(a.root, {
        now,
        reason: `确认改动前（勾选 ${picks.length} 条 · ${kind === 'fold' ? '折叠' : '删除'}）`,
        version: PLUGIN_VERSION,
      })
    } catch (error) {
      throw new Error(`备份失败，一个字都没动：${error && error.message ? error.message : error}`)
    }
    if (!backup || !backup.dir) throw new Error('备份没有产出目录，一个字都没动')

    // ② 按行改。**从后往前**，否则前面一删，后面的行号全错位。
    const filePath = join(a.root, 'AGENTS.md')
    const before = readFileSync(filePath, 'utf8')
    const lines = before.split('\n')
    const beforeBytes = Buffer.byteLength(before, 'utf8')
    const sorted = targets.slice().sort((x, y) => (Number(y.line) || 0) - (Number(x.line) || 0))
    const changed = []
    const skipped = []
    for (const t of sorted) {
      const start = Number(t.line) - 1
      const text = String(t.text || '').trim()
      const count = text.split('\n').length
      if (!Number.isInteger(start) || start < 0 || start + count > lines.length) {
        skipped.push({ block: t.block || 'B0', line: t.line, why: '行号越界' })
        continue
      }
      // 保险：这一行的内容得对得上（行号可能因为别的改动漂了）
      const head = String(lines[start] || '').trim()
      const sample = text.split('\n')[0].trim().slice(0, 24)
      if (sample && !head.includes(sample.slice(0, Math.min(sample.length, 12)))) {
        skipped.push({ block: t.block || 'B0', line: t.line, why: '这一行的内容和候选对不上（行号漂了）' })
        continue
      }
      let replaced = []
      if (kind === 'fold') {
        // 折叠的正文**必须是他自己写的那句**（2026-11-08 定的）。
        // 机器生成的那句是「（缺来由…待补…）」，落盘等于把原文换成废话 —— 宁可跳过。
        const mine = String(summaries[t.__n] || summaries[t.n] || '').trim()
        if (!mine) {
          skipped.push({ block: t.block || 'B0', line: t.line, why: '没写摘要：折叠需要你给一句"留成什么"' })
          continue
        }
        replaced = [mine]
      }
      lines.splice(start, count, ...replaced)
      changed.push({
        block: t.block || 'B0',
        line: t.line,
        kind,
        before: text.slice(0, 120),
        after: replaced.join('\n').slice(0, 120),
      })
    }
    if (!changed.length) {
      const why = skipped.length ? skipped.map((s) => `[${s.block}] ${s.why}`).join('；') : '一条都没匹配上'
      badRequest(`没动文件：${why}。请重新点「看候选」再勾`)
    }

    const after = lines.join('\n')
    // ⚠️ AGENTS.md 是**隐藏文件**（Attributes: Hidden）。Node 直接 writeFileSync 会 EPERM，
    // 所以先 `attrib -h` 摘掉、写完再挂回来 —— memory-digest.ps1 就是这么做的（同一族坑）。
    let attrsStripped = false
    try {
      execFileSync('attrib', ['-h', filePath], { windowsHide: true })
      attrsStripped = true
    } catch (error) {
      log(`摘隐藏属性失败（继续尝试写）：${error && error.message}`)
    }
    try {
      writeFileSync(filePath, after, 'utf8')
    } finally {
      if (attrsStripped) {
        try { execFileSync('attrib', ['+h', filePath], { windowsHide: true }) } catch (e) { log(`恢复隐藏属性失败：${e && e.message}`) }
      }
    }
    const afterBytes = Buffer.byteLength(after, 'utf8')

    // ③ 留痕：改了哪几条、备份在哪、怎么恢复。**误删之后全靠这一份。**
    let logPath = null
    try {
      const dir = backupRoot(a.root)
      mkdirSync(dir, { recursive: true })
      logPath = join(dir, `改动记录-${todayStamp(now)}.md`)
      const body = [
        `# ${todayStamp(now)} 遗忘曲线 · 手动确认的改动`,
        '',
        `- 动作：${kind === 'fold' ? '折叠' : '删除'} ${changed.length} 条`,
        `- 大小：${nf(beforeBytes)} B → ${nf(afterBytes)} B（省 ${nf(Math.max(0, beforeBytes - afterBytes))} B）`,
        `- **改动前备份：${backup.dir}**`,
        `- 恢复命令：\`node index.js --restore ${todayStamp(now)}\`（或面板上点「恢复最近备份」）`,
        '',
        '## 改了哪几条',
        '',
        ...changed.map((c, i) => [
          `${i + 1}. [${c.block}] 原第 ${c.line} 行`,
          '   - 原文：' + c.before.replace(/\n/g, ' ⏎ '),
          c.after ? '   - 现在：' + c.after.replace(/\n/g, ' ⏎ ') : '   - 现在：（已删除）',
        ].join('\n')),
        '',
      ].join('\n')
      writeFileSync(logPath, body, 'utf8')
    } catch (error) {
      log(`改动记录没写进盘（改动本身已经生效）：${error && error.message}`)
    }

    return {
      ok: true,
      op,
      kind,
      changed: changed.length,
      beforeBytes,
      afterBytes,
      saved: Math.max(0, beforeBytes - afterBytes),
      backupPath: backup.dir,
      logPath,
      items: changed,
      skipped,
      message: `已${kind === 'fold' ? '折叠' : '删除'} ${changed.length} 条：${nf(beforeBytes)} B → ${nf(afterBytes)} B（省 ${nf(Math.max(0, beforeBytes - afterBytes))} B）。备份在 ${backup.dir}` +
        (skipped.length ? `；跳过 ${skipped.length} 条（${skipped.map((s) => s.why).join('、')}）` : ''),
      snapshot: snapshotNow({ cfg, now, root }),
    }
  }

  // 恢复（2026-11-08）：误删了就靠它。默认恢复最近一份完整备份。
  if (op === 'restore') {
    const date = String((extra && extra.date) || '').trim()
    const list = listBackups(root).filter((b) => b.complete)
    if (!list.length) badRequest('没有可用的完整备份')
    const target = date && date !== 'latest'
      ? list.find((b) => b.date === date)
      : list[0]
    if (!target) badRequest(`找不到 ${date} 那份备份；可用的是：${list.map((b) => b.date).join('、')}`)
    const out = restore(root, { date: target.date })
    return {
      ok: true,
      op,
      date: target.date,
      restored: out && out.restored ? out.restored : [],
      message: `已从 ${target.date} 的备份恢复${out && out.restored ? '（' + out.restored.join('、') + '）' : ''}`,
      snapshot: snapshotNow({ cfg, now, root }),
    }
  }

  if (op === 'scan') {
    // 只重算，不写盘 —— 跟 GET /snapshot 同一条路，扫描永远安全。
    const snapshot = snapshotNow({ cfg, now, root })
    return {
      ok: true, op,
      message: `已重新扫描：${nf(snapshot.totalBytes)} B / ${nf(snapshot.limitBytes)} B（${pct(snapshot.totalBytes)}%）`,
      snapshot,
    }
  }

  if (op === 'report') {
    const out = runOnce({ cfg, now, root })
    return {
      ok: true, op,
      reportPath: out.reportPath,
      transferLog: out.transferLog,
      message: out.reportPath ? `报告：${out.reportPath}` : '报告算出来了，但没写进盘（看宿主日志）',
      snapshot: buildSnapshot(out.analysis, { reportPath: out.reportPath, now }),
    }
  }

  // op === 'backup'：真备份，但**只读源文件**（copyFileSync 从源读、往备份目录写）
  const a = analyze({ cfg, now, root })
  const b = backupPair(a.root, { now, reason: '面板手动备份', version: PLUGIN_VERSION })
  return {
    ok: true, op,
    backupPath: b.dir,
    manifestPath: b.manifestPath,
    files: b.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
    message: `已备份到 ${b.dir}（${b.files.map((f) => `${f.name} ${nf(f.bytes)} B`).join('、')}）`,
    snapshot: buildSnapshot(a, { now }),
  }
}

function registerJsonRoute(webServer, route) {
  try {
    return webServer.register(route)
  } catch (error) {
    // 热重载时同一进程里上一次的 disposer 可能还没跑 —— 记一笔，别把整个插件带下去。
    log(`路由 ${route.path} 没挂上（可能已被占用）：${error && error.message}`)
    return () => {}
  }
}

/**
 * `ctx.effect` 的薄包装：效果必须随 fiber 一起销毁。
 *
 * 没有 ctx.effect 的宿主（不该有，但别赌）退回直接注册，并且**明确说清退不回**——
 * 宁可日志里难看，也不要假装清掉了。
 */
function effectOf(ctx, factory, label) {
  if (ctx && typeof ctx.effect === 'function') {
    try {
      return ctx.effect(factory)
    } catch (error) {
      log(`ctx.effect(${label}) 挂了：${error && error.message} —— 退回直接注册`)
    }
  } else {
    log(`宿主没有 ctx.effect（${label}）：这份资源将无法随卸载清理`)
  }
  try { return factory() } catch (error) { log(`${label} 注册失败：${error && error.message}`); return () => {} }
}

// ---------------------------------------------------------------------------
// 设置命名空间
// ---------------------------------------------------------------------------

async function tryLoadSchema() {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const z = mod && mod.default ? mod.default : mod
    return z.object({
      workspace: z.string().default(DEFAULT_CONFIG.workspace).description('工作区（只读这里的 AGENTS.md / AGENTS.local.md）'),
      periodDays: z.number().min(7).max(365).default(30).description('多久体检一次（天）'),
      mode: z.string().default('proposal').description('proposal = 只出提案（默认）；auto 也只许折叠/删一级二级，三级永不自动'),
      backup: z.boolean().default(true).description('动手前整份备份到 _handover\\_记忆备份\\YYYY-MM-DD\\'),
      autoOnAlert: z.boolean().default(true).description('注入块到 85%（55,705 B）立刻跑一次'),
      reportDir: z.string().default('').description('月报目录（留空 = _handover\\_记忆备份\\_报告）'),
    })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx) {
  // 文件里的配置 + 设置页覆盖层（设置页优先）。每次要配置都现读一次文件，
  // 这样定时器写进去的 lastRunAt 立刻生效，不用等重载。
  let overlay = {}
  const effCfg = () => ({ ...loadConfig(), ...overlay })

  // ---- 设置命名空间 ------------------------------------------------------
  try {
    const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : null
    if (settings && typeof settings.register === 'function') {
      ;(async () => {
        const schema = await tryLoadSchema()
        if (!schema) return
        try {
          const scope = settings.register(NS, schema)
          const pull = () => { overlay = (scope && typeof scope.get === 'function' ? scope.get() : null) || {} }
          pull()
          if (scope && typeof scope.watch === 'function') scope.watch(pull)
        } catch (error) {
          log(`设置命名空间没注册上（报告照常出）：${error.message}`)
        }
      })()
    }
  } catch (error) {
    log(`拿不到 settings：${error.message}`)
  }

  // ---- 第二条：只读路由（幂等，服务晚到也能补上）--------------------------
  //
  // 为什么幂等：cordis 起服务是同一趟里按行顺序来的，`webServer` 正常在 apply 前就有了；
  // 但要是这次的顺序不一样（或者宿主是老的），这里不能就这么算了 ——
  // 定时器第一次 tick 会再调一次 mountRoutes()，晚了就补上，早就不动。

  // GET 的快照缓存：analyze() 要重读 AGENTS.md + AGENTS.local.md，还要把整份 `_memory\主线.md`
  // 建成索引 —— 面板每 60 秒轮询一次，不缓存等于每分钟白算一遍。
  // 30 秒 TTL：轮询拿到的是新的，手动"重新扫描"走 POST op=scan（**绕过缓存**，永远现算）。
  const SNAPSHOT_TTL_MS = 30 * 1000
  let snapCache = null // { at: number, value }
  const cachedSnapshot = (cfg) => {
    const at = Date.now()
    if (snapCache && at - snapCache.at < SNAPSHOT_TTL_MS) return snapCache.value
    const value = snapshotNow({ cfg })
    snapCache = { at, value }
    return value
  }

  let routesMounted = false
  // 2026-11-08 实测：DSH 重启后插件可能比 `webServer` 服务先 apply（面板报 404/405），
  // 那时直接 return 就再也补不上了 —— 手动重载一次插件才回来。所以这里改成**自己重试**，
  // 最多 12 次 × 2.5 秒（约 30 秒），够 webServer 起来了；期间不重复挂（routesMounted 挡住）。
  let mountTries = 0
  const MOUNT_TRY_MAX = 12
  const MOUNT_TRY_GAP_MS = 2500
  const mountRoutes = () => {
    if (routesMounted) return
    const webServer = (ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined) || (ctx && ctx.webServer)
    if (!webServer || typeof webServer.register !== 'function') {
      mountTries += 1
      if (mountTries <= MOUNT_TRY_MAX) {
        log(`webServer 还没就绪，${MOUNT_TRY_GAP_MS / 1000} 秒后重试（第 ${mountTries}/${MOUNT_TRY_MAX} 次）`)
        const t = setTimeout(() => { try { mountRoutes() } catch {} }, MOUNT_TRY_GAP_MS)
        if (t && typeof t.unref === 'function') t.unref()
      } else {
        log('webServer 一直没就绪：这次没挂路由（面板会显示"读不到宿主"）。重载一次插件就能补上。')
      }
      return
    }
    routesMounted = true

    effectOf(ctx, () => {
      const stopSnapshot = registerJsonRoute(webServer, {
        kind: 'exact',
        path: SNAPSHOT_PATH,
        // ⛔ 纯只读：不看 req.url，不看查询串。同一份地址永远是同一份数据。
        handler(req, res) {
          if (req.method !== 'GET') {
            jsonResponse(res, { ok: false, error: '这个路由只读：只接受 GET' }, 405)
            return
          }
          try {
            jsonResponse(res, cachedSnapshot(effCfg()))
          } catch (error) {
            jsonResponse(res, { ok: false, error: error && error.message ? error.message : String(error) }, 500)
          }
        },
      })

      const stopAction = registerJsonRoute(webServer, {
        kind: 'exact',
        path: ACTION_PATH,
        async handler(req, res) {
          if (req.method !== 'POST') {
            jsonResponse(res, { ok: false, error: '三个按钮走 POST' }, 405)
            return
          }
          if (!isSameOrigin(req)) {
            jsonResponse(res, { ok: false, error: '跨站请求被拒绝' }, 403)
            return
          }
          let body
          try { body = await readJsonBody(req) } catch (error) {
            jsonResponse(res, { ok: false, error: error && error.message ? error.message : '请求体读不出来' }, 400)
            return
          }
          // ⛔ 接口只认 `op`。带了别的键 → 当场拒，不是"静默忽略"：
          //    没有任何参数能左右要写哪个文件，路径全在宿主这边按配置算。
          const keys = Object.keys(body || {}).filter((k) => k !== 'op')
          const forbidden = keys.filter((k) => FORBIDDEN_ACTION_KEYS.includes(k))
          if (forbidden.length) {
            jsonResponse(res, { ok: false, error: `这个路由不接受路径类参数：${forbidden.join(', ')}` }, 400)
            return
          }
          // 只放行这三个键：setMode 的 `mode`、items 的 `kind`、apply 的 `kind`+`picks`、restore 的 `date`。
          // 别的键一概拒，不静默忽略。
          const opRaw = (body && body.op)
          const allowedExtra = opRaw === 'setMode'
            ? ['mode']
            : opRaw === 'items' ? ['kind']
              : opRaw === 'apply' ? ['kind', 'picks', 'summaries']
                : opRaw === 'restore' ? ['date'] : []
          const unknown = keys.filter((k) => !allowedExtra.includes(k))
          if (unknown.length) {
            jsonResponse(res, { ok: false, error: `只接受 op${allowedExtra.length ? ' / ' + allowedExtra.join(' / ') : ''}；不认识：${unknown.join(', ')}` }, 400)
            return
          }
          const op = String((body && body.op) || '')
          if (!ACTION_OPS.includes(op)) {
            jsonResponse(res, { ok: false, error: `未知操作「${op || '(空)'}」；只许 ${ACTION_OPS.join(' / ')}` }, 400)
            return
          }
          try {
            const result = runAction(op, effCfg(), new Date(), {
              mode: body && body.mode,
              kind: body && body.kind,
              picks: body && body.picks,
              summaries: body && body.summaries,
              date: body && body.date,
            })
            // 这一趟已经算过了，顺手把缓存换成它 —— 面板紧接着的轮询就不会再算一遍。
            if (result && result.snapshot) snapCache = { at: Date.now(), value: result.snapshot }
            jsonResponse(res, result)
          } catch (error) {
            jsonResponse(res, { ok: false, op, error: error && error.message ? error.message : String(error) }, (error && error.status) || 500)
          }
        },
      })

      return () => {
        try { stopSnapshot() } catch {}
        try { stopAction() } catch {}
        routesMounted = false
        log('路由已摘掉')
      }
    }, 'forgetting-curve: readonly routes')

    log(`只读快照：GET ${SNAPSHOT_PATH}　·　按钮入口：POST ${ACTION_PATH}（op = ${ACTION_OPS.join('/')}）`)
  }

  mountRoutes()

  // ---- 第二件：定时检查 ---------------------------------------------------
  //
  // 判据不重写：全部委托给 shouldRun()（85% 立刻跑 / 满 periodDays 跑 / 从没跑过就跑）。
  // 这里只多做两件事：① 别在 20 小时内重复跑（热重载 + 重启会重复 apply）；
  //                    ② 每轮多写一份 snapshot.json 当天花板副本。
  const TICK_MS = 6 * 3600 * 1000 // 每 6 小时看一眼（判据是 shouldRun，不是这个间隔）
  const FIRST_MS = 45 * 1000 // 启动 45 秒后先看一次 —— 85% 线要"立刻"，不能等 6 小时
  // 不重复跑的间隔。为什么是 20 小时不是 1 小时：
  //   报告文件名带日期（`YYYY-MM-DD-遗忘报告.md`），一天里跑第二遍只是把同一份文件重写一次 ——
  //   所以"踩了 85% 就一直每 6 小时跑"只会白写盘。20 小时 ≈ 一天一次，既守住"过线就天天看着"，
  //   又让"启动时过线、从没跑过"这种情形照旧立刻跑（lastRunAt 为空 → ranRecently 直接 false）。
  const MIN_GAP_MS = 20 * 3600 * 1000

  const ranRecently = (cfg, now) => {
    if (!cfg.lastRunAt) return false
    const last = new Date(cfg.lastRunAt).getTime()
    if (!Number.isFinite(last)) return false
    return now.getTime() - last < MIN_GAP_MS
  }

  const tick = (source) => {
    try {
      mountRoutes() // 服务晚到就在这儿补（幂等）
      const cfg = effCfg()
      const sources = readSources(rootOf(cfg))
      if (!sources.files.length) {
        log(`跳过：${rootOf(cfg)} 下找不到 AGENTS.md / AGENTS.local.md`)
        return
      }
      const now = new Date()
      const due = shouldRun(sources, cfg, now)
      if (!due.run) return
      if (ranRecently(cfg, now)) {
        log(`跳过（${source}）：${due.why}，但 ${Math.round(MIN_GAP_MS / 3600000)} 小时内刚跑过`)
        return
      }
      log(`跑一轮（${source}）：${due.why}`)
      const out = runOnce({ cfg, now })
      // 不管 proposal 还是 auto：到这里都只写了报告 / 留痕 / snapshot.json，
      // AGENTS.md 和 AGENTS.local.md 一个字节都没动（auto 只是多一份动手前备份）。
      if (out.reportPath) log(`报告：${out.reportPath}`)
      if (out.snapshotPath) log(`快照：${out.snapshotPath}`)
    } catch (error) {
      log(`这一轮没跑成：${error && error.message}`)
    }
  }

  // ⚠️ 硬要求：定时器必须能被卸载清掉。
  // 优先用宿主的 `timer` 服务（`ctx.get('timer').interval/timeout`，返回 disposer，随 fiber 销毁）；
  // 拿不到才退回裸 setInterval/setTimeout —— 但**一样包在 ctx.effect 的清理函数里**，不留裸的。
  effectOf(ctx, () => {
    const stops = []
    const timerService = (ctx && typeof ctx.get === 'function' ? ctx.get('timer') : undefined) || null

    if (timerService && typeof timerService.interval === 'function' && typeof timerService.timeout === 'function') {
      stops.push(timerService.timeout(() => tick('启动后第一次'), FIRST_MS))
      stops.push(timerService.interval(() => tick('定时'), TICK_MS))
    } else {
      const first = setTimeout(() => tick('启动后第一次'), FIRST_MS)
      if (typeof first.unref === 'function') first.unref()
      const every = setInterval(() => tick('定时'), TICK_MS)
      if (typeof every.unref === 'function') every.unref()
      stops.push(() => clearTimeout(first), () => clearInterval(every))
    }

    log(`定时检查已挂上：启动后 ${FIRST_MS / 1000}s 看一次，之后每 ${TICK_MS / 3600000}h 一次`)

    return () => {
      for (const stop of stops) {
        try { stop() } catch {}
      }
      log('定时检查已清掉')
    }
  }, 'forgetting-curve: schedule')
}

export default { name, NS, inject, apply, version: PLUGIN_VERSION }

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

function isMain() {
  try {
    return Boolean(process.argv[1]) && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()
  } catch { return false }
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--restore') args.restore = argv[++i] || 'latest'
    else if (a === '--backup') args.backup = true
    else if (a === '--report') args.report = true
    else if (a === '--now') args.now = argv[++i]
    else if (a === '--root') args.root = argv[++i]
    else if (a === '--json') args.json = true
    else if (a === '--snapshot') args.snapshot = true
    else if (a === '--dry-run') args.dry = true
    else if (a === '--list-backups') args.listBackups = true
    else args._.push(a)
  }
  return args
}

async function cli(argv) {
  const args = parseArgs(argv)
  const cfg = loadConfig()
  const root = args.root || rootOf(cfg)
  try {
    if (args.listBackups) {
      const list = listBackups(root)
      if (!list.length) return console.log(`没有备份：${backupRoot(root)}`)
      for (const b of list) console.log(`${b.date}  ${b.complete ? `${b.manifest.files.length} 份` : '缺 manifest'}  ${b.dir}`)
      return
    }
    if (args.backup) {
      const out = backupPair(root, { reason: '手动备份' })
      return console.log(`已备份到 ${out.dir}（${out.files.map((f) => `${f.name} ${nf(f.bytes)} B`).join('、')}）`)
    }
    if (args.restore) {
      const out = restore(root, { date: args.restore, dryRun: Boolean(args.dry) })
      for (const line of out.log) console.log(line)
      return console.log(`恢复源：${out.dir}（${out.date}）`)
    }
    const now = args.now ? new Date(args.now) : new Date()
    // 面板拿到的就是这份 —— 命令行也能看，方便"路由没挂上"时对答案。
    if (args.snapshot) return console.log(JSON.stringify(snapshotNow({ cfg, now, root }), null, 2))
    const a = analyze({ cfg, now, root })
    if (args.json) {
      return console.log(JSON.stringify({
        total: a.sources.total, after: a.afterBytes,
        blocks: a.blocks.map((b) => ({ id: b.id, bytes: b.bytes, quota: b.quota, 三级: b.counts.三级, 二级: b.counts.二级, 一级: b.counts.一级, 折: b.fold.length, 删: b.remove.length })),
        fold: a.foldable.map((it) => ({ block: it.block, summary: it.summary, bytes: it.bytes })),
        remove: a.deletable.map((it) => ({ block: it.block, summary: it.summary, bytes: it.bytes })),
        noCause: a.noCause.length, sealed: a.sealed.length,
      }, null, 2))
    }
    const report = renderReport(a)
    console.log(report)
    if (args.report) {
      const dir = reportDirFor(cfg, root)
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${todayStamp(now)}-遗忘报告.md`)
      writeFileSync(path, `${report}\n`, 'utf8')
      const tl = appendTransferLog(dir, a.transfers, now)
      console.log(`\n→ 已写入 ${path}${tl ? `\n→ 调配留痕 ${tl}` : ''}`)
    }
  } catch (error) {
    console.error(`[遗忘曲线] ${error && error.stack ? error.stack : error}`)
    process.exitCode = 1
  }
}

if (isMain()) void cli(process.argv.slice(2))
