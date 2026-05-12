'use strict'

const path = require('path')
const pino = require('pino')
const QRCode = require('qrcode')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason
} = require('@whiskeysockets/baileys')

const db = require('./database')
const { processTransactionImage, generateFinancialReport } = require('./gemini')

const AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys')
const logger = pino({ level: 'silent' })

const fmt = (n, cur = 'COP') => {
  if (n == null) return 'N/D'
  try {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n)
  } catch { return `${n} ${cur}` }
}

async function initWhatsApp(broadcast) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: true,
    syncFullHistory: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 })
        broadcast('qr', { qrDataUrl })
        console.log('  [WhatsApp] QR generado — escanéalo en el panel web')
      } catch (err) {
        console.error('  [WhatsApp] Error generando QR:', err.message)
      }
    }

    if (connection === 'open') {
      console.log('  [WhatsApp] Conectado correctamente')
      broadcast('connected', { message: 'WhatsApp conectado' })
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const errorMsg = lastDisconnect?.error?.message ?? 'desconocido'
      const loggedOut = statusCode === DisconnectReason.loggedOut

      broadcast('status', { connected: false })
      console.log(`  [WhatsApp] Desconectado. Código: ${statusCode} — ${errorMsg}`)

      if (loggedOut) {
        console.log('  [WhatsApp] Sesión cerrada. Borra auth_info_baileys/ y reinicia.')
      } else {
        console.log('  [WhatsApp] Reconectando en 5s...')
        setTimeout(() => initWhatsApp(broadcast), 5000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.message) continue

      const jid = msg.key.remoteJid
      if (!jid || jid === 'status@broadcast') continue

      // ── Image message ───────────────────────────────────────
      const imageMsg = msg.message.imageMessage
      if (imageMsg) {
        console.log(`  [WhatsApp] Imagen recibida de ${jid}`)
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {})
          const mimeType = imageMsg.mimetype || 'image/jpeg'

          console.log('  [Gemini] Procesando imagen...')
          const txData = await processTransactionImage(buffer, mimeType)
          console.log(`  [Gemini] ${txData.type.toUpperCase()} — ${txData.provider} — ${txData.amount} ${txData.currency}`)

          const saved = db.insertTransaction({ ...txData, sender_jid: jid, imageBuffer: buffer, imageMime: mimeType })
          broadcast('transaction', saved)

          const typeLabel = txData.type === 'ingreso' ? 'INGRESO' : 'EGRESO'
          const typeIcon  = txData.type === 'ingreso' ? '[+]' : '[-]'
          const monthStats = db.getCurrentMonthStats()

          const reply = `${typeIcon} *${typeLabel} registrado*\n\n` +
            `Fecha: ${txData.date ?? 'No detectada'}\n` +
            `Proveedor/Origen: ${txData.provider ?? 'Desconocido'}\n` +
            `Categoría: ${txData.category}\n` +
            `Importe: ${fmt(txData.amount, txData.currency)}\n` +
            `${txData.taxes ? `IVA/Impuestos: ${fmt(txData.taxes, txData.currency)}\n` : ''}` +
            `${txData.notes ? `Nota: ${txData.notes}\n` : ''}` +
            `\n*Resumen del mes:*\n` +
            `Ingresos: ${fmt(monthStats.ingresos)}\n` +
            `Egresos: ${fmt(monthStats.egresos)}\n` +
            `Balance: ${fmt(monthStats.balance)}`

          await sock.sendMessage(jid, { text: reply })
        } catch (err) {
          console.error('  [Error] Procesando imagen:', err.message)
          try { await sock.sendMessage(jid, { text: 'No pude procesar la imagen. Asegurate de que sea un documento financiero legible.' }) } catch {}
        }
        continue
      }

      // ── Text message ────────────────────────────────────────
      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text || ''
      ).trim().toLowerCase()

      if (!text) continue

      // Manual entry: "ingreso 500000 descripcion" or "egreso 80000 supermercado"
      const manualMatch = text.match(/^(ingreso|egreso)\s+([\d.,]+)(?:\s+(.+))?$/)
      if (manualMatch) {
        const txType = manualMatch[1]
        const amount = parseFloat(manualMatch[2].replace(/[.,]/g, (m, i, s) =>
          s.indexOf('.') !== s.lastIndexOf('.') || m === ',' ? '' : m
        ))
        const description = manualMatch[3] || null

        try {
          const saved = db.insertTransaction({
            type: txType,
            category: txType === 'ingreso' ? 'Ventas' : 'Otro',
            provider: description,
            amount: isNaN(amount) ? null : amount,
            currency: 'COP',
            sender_jid: jid
          })
          broadcast('transaction', saved)

          const monthStats = db.getCurrentMonthStats()
          await sock.sendMessage(jid, {
            text: `[${txType === 'ingreso' ? '+' : '-'}] *${txType.toUpperCase()}* registrado: ${fmt(saved.amount)}\n\n` +
              `*Mes actual:*\nIngresos: ${fmt(monthStats.ingresos)}\nEgresos: ${fmt(monthStats.egresos)}\nBalance: ${fmt(monthStats.balance)}`
          })
        } catch (err) {
          console.error('  [Error] Entrada manual:', err.message)
        }
        continue
      }

      // Commands
      if (text === 'balance' || text === 'saldo') {
        const m = db.getCurrentMonthStats()
        const all = db.getAllTransactions()
        const totalIng = all.filter(t => t.type === 'ingreso').reduce((s, t) => s + (t.amount ?? 0), 0)
        const totalEgr = all.filter(t => t.type === 'egreso').reduce((s, t) => s + (t.amount ?? 0), 0)
        await sock.sendMessage(jid, {
          text: `*Balance actual*\n\n` +
            `--- Este mes ---\nIngresos: ${fmt(m.ingresos)}\nEgresos: ${fmt(m.egresos)}\nBalance mes: ${fmt(m.balance)}\n\n` +
            `--- Histórico total ---\nIngresos: ${fmt(totalIng)}\nEgresos: ${fmt(totalEgr)}\nBalance total: ${fmt(totalIng - totalEgr)}`
        })
        continue
      }

      if (text === 'resumen' || text === 'resumen mes') {
        const m = db.getCurrentMonthStats()
        const now = new Date()
        const monthName = now.toLocaleString('es-CO', { month: 'long', year: 'numeric' })
        await sock.sendMessage(jid, {
          text: `*Resumen de ${monthName}*\n\n` +
            `Ingresos: ${fmt(m.ingresos)}\nEgresos: ${fmt(m.egresos)}\nBalance: ${fmt(m.balance)}\nTransacciones: ${m.count}`
        })
        continue
      }

      if (text === 'informe' || text === 'reporte') {
        try {
          await sock.sendMessage(jid, { text: 'Generando informe financiero con IA, espera un momento...' })
          const now = new Date()
          const monthTxs = db.getLast6Months().flatMap(m => {
            const txs = db.getAllTransactions()
            return txs.filter(t => t.created_at.startsWith(m.month))
          })
          const period = `últimos 6 meses hasta ${now.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' })}`
          const report = await generateFinancialReport(monthTxs.slice(0, 80), period)
          const chunks = []
          for (let i = 0; i < report.length; i += 3900) chunks.push(report.slice(i, i + 3900))
          for (const chunk of chunks) await sock.sendMessage(jid, { text: chunk })
        } catch (err) {
          await sock.sendMessage(jid, { text: 'Error generando el informe. Intenta de nuevo.' })
        }
        continue
      }

      if (text === 'ayuda' || text === 'help' || text === 'menu' || text === 'inicio') {
        await sock.sendMessage(jid, {
          text: `*Asistente Contable*\n\n` +
            `*Registrar con imagen:*\nEnvia la foto de cualquier factura, recibo, consignacion o comprobante.\n\n` +
            `*Registrar manualmente:*\ningreso 500000 descripcion\negreso 80000 supermercado\n\n` +
            `*Comandos:*\n"balance" — saldo actual\n"resumen" — resumen del mes\n"informe" — informe financiero completo con IA\n"ayuda" — este menu`
        })
        continue
      }
    }
  })
}

module.exports = { initWhatsApp }
