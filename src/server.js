'use strict'

require('dotenv').config()

if (!process.env.GEMINI_API_KEY) {
  console.error('\n[ERROR] GEMINI_API_KEY no configurada en .env\n')
  process.exit(1)
}

const http = require('http')
const path = require('path')
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')
const db = require('./database')
const { initWhatsApp } = require('./whatsapp')
const { generateFinancialReport } = require('./gemini')

const PORT = parseInt(process.env.PORT || '3000', 10)

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, '..', 'public')))
app.use('/images', express.static(db.IMAGES_DIR))

// ── REST API ────────────────────────────────────────────────

app.get('/api/transactions', (_req, res) => {
  res.json(db.getAllTransactions())
})

app.get('/api/stats/today', (_req, res) => {
  res.json(db.getTodayStats())
})

app.get('/api/stats/month', (req, res) => {
  const now = new Date()
  const year  = parseInt(req.query.year  || now.getFullYear())
  const month = parseInt(req.query.month || now.getMonth() + 1)
  res.json(db.getMonthStats(year, month))
})

app.get('/api/stats/months', (_req, res) => {
  res.json(db.getLast6Months())
})

app.get('/api/stats/period', (req, res) => {
  const { start, end } = req.query
  if (!start || !end) return res.status(400).json({ error: 'start y end requeridos' })
  res.json(db.getPeriodStats(start, end))
})

app.post('/api/report', async (req, res) => {
  try {
    const { start, end } = req.body
    let txs = db.getAllTransactions()
    let period = 'total'

    if (start && end) {
      const s = new Date(start), e = new Date(end + 'T23:59:59')
      txs = txs.filter(t => { const d = new Date(t.created_at); return d >= s && d <= e })
      period = `${start} al ${end}`
    } else {
      const now = new Date()
      period = `últimos 6 meses hasta ${now.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' })}`
    }

    if (txs.length === 0) return res.json({ report: 'No hay transacciones en el período seleccionado.' })

    const report = await generateFinancialReport(txs, period)
    res.json({ report })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── WebSocket ───────────────────────────────────────────────

const httpServer = http.createServer(app)
const wss = new WebSocketServer({ server: httpServer })
const clients = new Set()

wss.on('connection', (ws) => {
  clients.add(ws)

  try {
    const monthStats = db.getCurrentMonthStats()
    const months6    = db.getLast6Months()
    ws.send(JSON.stringify({
      type: 'init',
      data: {
        transactions: db.getAllTransactions(),
        monthStats,
        months6
      }
    }))
  } catch {}

  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data })
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload) } catch {}
    }
  }
}

// ── Start ───────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n  ╔════════════════════════════════════════╗`)
  console.log(`  ║   FinBot — Contador Virtual            ║`)
  console.log(`  ║   http://localhost:${PORT}               ║`)
  console.log(`  ╚════════════════════════════════════════╝\n`)
  initWhatsApp(broadcast)
})
