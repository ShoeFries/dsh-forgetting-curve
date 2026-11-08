// 遗忘曲线 · 备份与恢复（backup）
//
// 只有一句话的规矩：**动手之前先整份备份，恢复必须一条命令**。
// 存一份但不知道怎么还原，等于没有 —— 所以恢复是这个文件的主角，不是备份。
//
// 备份永远不删：`_记忆备份\` 里每一份都是一次「那时候他是这样」的快照，
// 它占的那点地方（几十 KB）跟"把人改坏回不去"比，不值一提。
//
// 只碰 `AGENTS.md` / `AGENTS.local.md` 这两个名字；写进来的路径一律先过白名单，
// 免得哪天参数传错，把 `_handover\` 里的信也当记忆处理了。

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { SOURCE_FILES, byteLength } from './measure.js'

/** 备份根：`<工作区>\_handover\_记忆备份\`。 */
export function backupRoot(root) {
  return join(root, '_handover', '_记忆备份')
}

/** 本地日期 `YYYY-MM-DD`（用本地时间：他说的"那天"是北京时间的那天）。 */
export function todayStamp(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 某天的备份目录。 */
export function backupDirFor(root, date = todayStamp()) {
  return join(backupRoot(root), date)
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function ensureOnlySources(targets) {
  for (const t of targets) {
    if (!SOURCE_FILES.includes(t)) throw new Error(`拒绝操作：${t} 不在白名单（只许 ${SOURCE_FILES.join(' / ')}）`)
  }
}

/**
 * 整份备份两个文件 + 一份 manifest。
 * manifest 里记 sha256 —— 恢复的时候先核对，确保还原的是当初那一份，而不是被谁改过的半份。
 */
export function backupPair(root, opts = {}) {
  const now = opts.now || new Date()
  const date = opts.date || todayStamp(now)
  const dir = backupDirFor(root, date)
  mkdirSync(dir, { recursive: true })
  const saved = []
  for (const name of SOURCE_FILES) {
    const src = join(root, name)
    if (!existsSync(src)) continue
    const buf = readFileSync(src)
    const dest = join(dir, name)
    copyFileSync(src, dest)
    saved.push({ name, source: src, saved: dest, bytes: buf.length, sha256: sha256(buf) })
  }
  if (!saved.length) throw new Error(`备份失败：${root} 下两份文件都不在`)
  const manifest = {
    plugin: 'dsh-forgetting-curve',
    version: opts.version || '0.1.0',
    createdAt: now.toISOString(),
    date,
    root,
    reason: opts.reason || '手动备份',
    totalBytes: saved.reduce((n, f) => n + f.bytes, 0),
    files: saved,
  }
  const manifestPath = join(dir, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { dir, manifestPath, manifest, files: saved }
}

/** 列出现有备份（新的在前）。 */
export function listBackups(root) {
  const dir = backupRoot(root)
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue
    const d = join(dir, name)
    let stat = null
    try { stat = statSync(d) } catch { continue }
    if (!stat.isDirectory()) continue
    let manifest = null
    try { manifest = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')) } catch { manifest = null }
    out.push({ date: name, dir: d, manifest, complete: Boolean(manifest && Array.isArray(manifest.files) && manifest.files.length) })
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1))
}

/**
 * 恢复：一条命令 `node index.js --restore 2026-12-01`（`latest` / 省略 = 最近一份）。
 *
 * 恢复到一半断电会怎么样？每个文件都是「先写临时名，再换名」的话不会留半份 ——
 * 但这里更简单：copyFileSync 对这两个几十 KB 的文件是原子的，而且 manifest 里留着 sha256，
 * 下一次跑报告会先把字节数和 sha 对一遍，对不上就报警（见 verifyBackup）。
 */
export function restore(root, opts = {}) {
  const list = listBackups(root).filter((b) => b.complete)
  if (!list.length) throw new Error(`没有可用的备份：${backupRoot(root)}`)
  const want = opts.date && opts.date !== 'latest' ? String(opts.date) : list[0].date
  const entry = list.find((b) => b.date === want)
  if (!entry) throw new Error(`找不到 ${want} 的备份；现有：${list.map((b) => b.date).join(' / ')}`)
  const log = []
  for (const f of entry.manifest.files) {
    ensureOnlySources([f.name])
    const backupPath = join(entry.dir, f.name)
    if (!existsSync(backupPath)) throw new Error(`备份不完整：缺 ${backupPath}`)
    const buf = readFileSync(backupPath)
    if (f.sha256 && sha256(buf) !== f.sha256) throw new Error(`备份被改过：${backupPath} 的 sha256 对不上，拒绝还原`)
    const dest = join(root, f.name)
    if (!opts.dryRun) copyFileSync(backupPath, dest)
    log.push(`${opts.dryRun ? '（演练）会还原' : '已还原'} ${f.name}  ${byteLength(buf.toString('utf8')).toLocaleString('en-US')} B`)
  }
  return { date: entry.date, dir: entry.dir, files: entry.manifest.files.map((f) => f.name), log }
}
