'use strict'

const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'data')
const DB_PATH = path.join(DATA_DIR, 'db.json')
const IMAGES_DIR = path.join(DATA_DIR, 'images')

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(IMAGES_DIR, { recursive: true })

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
    return raw
  } catch {
    // Migrate from old expenses.json if exists
    try {
      const old = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'expenses.json'), 'utf8'))
      const transactions = (old.invoices || []).map(inv => ({
        ...inv,
        type: 'egreso',
        category: 'Sin categoría',
        amount: inv.total,
        provider: inv.provider || 'Sin nombre'
      }))
      return { transactions, nextId: old.nextId || transactions.length + 1 }
    } catch {
      return { transactions: [], nextId: 1 }
    }
  }
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8')
}

function saveImage(id, buffer, mimeType) {
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'
  const filename = `${id}.${ext}`
  fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer)
  return filename
}

function insertTransaction(tx) {
  const db = load()
  const id = db.nextId++

  const imageFile = tx.imageBuffer
    ? saveImage(id, tx.imageBuffer, tx.imageMime || 'image/jpeg')
    : null

  const row = {
    id,
    created_at: new Date().toISOString(),
    type: tx.type || 'egreso',
    category: tx.category || 'Sin categoría',
    date: tx.date ?? null,
    provider: tx.provider ?? null,
    amount: tx.amount ?? null,
    taxes: tx.taxes ?? null,
    currency: tx.currency ?? 'COP',
    line_items: tx.line_items ?? [],
    notes: tx.notes ?? null,
    raw_json: tx.raw_json ?? null,
    sender_jid: tx.sender_jid ?? null,
    image_file: imageFile
  }

  db.transactions.unshift(row)
  save(db)
  return row
}

function getAllTransactions() {
  return load().transactions || []
}

function getCurrentMonthStats() {
  const now = new Date()
  return getMonthStats(now.getFullYear(), now.getMonth() + 1)
}

function getMonthStats(year, month) {
  const txs = getAllTransactions()
  const prefix = `${year}-${String(month).padStart(2, '0')}`
  const monthTxs = txs.filter(tx => {
    const d = tx.date || tx.created_at
    return d && (d.startsWith(prefix))
  })

  const ingresos = monthTxs.filter(t => t.type === 'ingreso').reduce((s, t) => s + (t.amount ?? 0), 0)
  const egresos  = monthTxs.filter(t => t.type === 'egreso').reduce((s, t) => s + (t.amount ?? 0), 0)

  const categorias = {}
  for (const t of monthTxs) {
    const k = `${t.type}:${t.category || 'Sin categoría'}`
    categorias[k] = (categorias[k] || 0) + (t.amount ?? 0)
  }

  return {
    month: prefix,
    ingresos,
    egresos,
    balance: ingresos - egresos,
    count: monthTxs.length,
    categorias
  }
}

function getLast6Months() {
  const now = new Date()
  const result = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    result.push(getMonthStats(d.getFullYear(), d.getMonth() + 1))
  }
  return result
}

function getPeriodStats(startDate, endDate) {
  const txs = getAllTransactions()
  const start = new Date(startDate)
  const end   = new Date(endDate + 'T23:59:59')
  const filtered = txs.filter(tx => {
    const d = new Date(tx.created_at)
    return d >= start && d <= end
  })
  const ingresos = filtered.filter(t => t.type === 'ingreso').reduce((s, t) => s + (t.amount ?? 0), 0)
  const egresos  = filtered.filter(t => t.type === 'egreso').reduce((s, t) => s + (t.amount ?? 0), 0)
  return { ingresos, egresos, balance: ingresos - egresos, count: filtered.length, transactions: filtered }
}

function getTodayStats() {
  const txs = getAllTransactions()
  const todayStr = new Date().toISOString().slice(0, 10)
  const todayTxs = txs.filter(tx => tx.created_at.startsWith(todayStr))
  const ingresos = todayTxs.filter(t => t.type === 'ingreso').reduce((s, t) => s + (t.amount ?? 0), 0)
  const egresos  = todayTxs.filter(t => t.type === 'egreso').reduce((s, t) => s + (t.amount ?? 0), 0)
  const last = txs[0]
  return {
    count: todayTxs.length,
    ingresos,
    egresos,
    balance: ingresos - egresos,
    lastTransaction: last
      ? `${last.provider ?? 'Sin nombre'} — ${formatCurrency(last.amount, last.currency)}`
      : null
  }
}

function formatCurrency(amount, currency) {
  if (amount == null) return 'N/D'
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: currency || 'COP',
      maximumFractionDigits: 0
    }).format(amount)
  } catch {
    return `${amount} ${currency || ''}`
  }
}

module.exports = {
  insertTransaction,
  getAllTransactions,
  getTodayStats,
  getCurrentMonthStats,
  getMonthStats,
  getLast6Months,
  getPeriodStats,
  IMAGES_DIR
}
