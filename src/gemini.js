'use strict'

const { GoogleGenerativeAI } = require('@google/generative-ai')

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

const EXTRACTION_PROMPT = `Eres un motor de extracción contable de documentos financieros (facturas, tickets, recibos, comprobantes de pago, consignaciones, transferencias, nóminas, etc.).

Analiza la imagen y extrae los campos indicados. Devuelve ÚNICAMENTE un objeto JSON válido, sin markdown, sin bloques de código, sin explicaciones.

Esquema JSON requerido:
{
  "type": "egreso" o "ingreso" (egreso = gasto/compra/pago realizado; ingreso = venta/cobro/transferencia recibida/consignación),
  "category": "una de estas categorías según el tipo: Alimentación, Transporte, Servicios, Salud, Tecnología, Nómina, Ventas, Arriendo, Impuestos, Proveedores, Inversión, Otro",
  "date": "YYYY-MM-DD o null",
  "provider": "nombre del comercio, empresa o persona como string, o null",
  "amount": número total (sin símbolo de moneda) o null,
  "taxes": número total de impuestos/IVA o null,
  "currency": "COP, USD, EUR u otro código ISO 4217. Si no se indica, asume COP",
  "notes": "observación breve si hay algo relevante, o null",
  "line_items": [{ "description": "string", "qty": número o null, "unit_price": número o null, "subtotal": número o null }]
}

Reglas:
- type DEBE ser "egreso" si es una factura de compra, ticket de supermercado, pago de servicios, etc.
- type DEBE ser "ingreso" si es un recibo de venta, comprobante de transferencia recibida, consignación, cobro.
- Todos los valores numéricos deben ser números, no strings.
- Si no puedes determinar un campo con certeza, usa null.
- line_items debe ser siempre un array (vacío si no hay ítems).
- No inventes datos. Solo extrae lo visible en la imagen.`

async function processTransactionImage(buffer, mimeType) {
  const base64 = buffer.toString('base64')
  const safeMime = ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType) ? mimeType : 'image/jpeg'

  const result = await model.generateContent([
    EXTRACTION_PROMPT,
    { inlineData: { data: base64, mimeType: safeMime } }
  ])

  const text = result.response.text().trim()
  let parsed

  try {
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error(`Gemini devolvió respuesta no parseable: ${text.slice(0, 200)}`)
  }

  return {
    type:       parsed.type === 'ingreso' ? 'ingreso' : 'egreso',
    category:   typeof parsed.category === 'string' ? parsed.category : 'Otro',
    date:       parsed.date ?? null,
    provider:   parsed.provider ?? null,
    amount:     typeof parsed.amount === 'number' ? parsed.amount : null,
    taxes:      typeof parsed.taxes  === 'number' ? parsed.taxes  : null,
    currency:   parsed.currency ?? 'COP',
    notes:      parsed.notes ?? null,
    line_items: Array.isArray(parsed.line_items) ? parsed.line_items : [],
    raw_json:   text
  }
}

async function generateFinancialReport(transactions, period) {
  const summary = transactions.slice(0, 100).map(t =>
    `${t.type.toUpperCase()} | ${t.category} | ${t.provider || 'N/A'} | ${t.amount ?? 0} ${t.currency} | ${t.date || t.created_at.slice(0,10)}`
  ).join('\n')

  const ingresos = transactions.filter(t => t.type === 'ingreso').reduce((s, t) => s + (t.amount ?? 0), 0)
  const egresos  = transactions.filter(t => t.type === 'egreso').reduce((s, t) => s + (t.amount ?? 0), 0)
  const balance  = ingresos - egresos

  const prompt = `Eres un contador y asesor financiero experto. Analiza el siguiente registro contable del período ${period} y genera un informe detallado en español.

RESUMEN DEL PERÍODO:
- Total ingresos: ${ingresos.toLocaleString('es-CO')} COP
- Total egresos: ${egresos.toLocaleString('es-CO')} COP
- Balance neto: ${balance.toLocaleString('es-CO')} COP
- Número de transacciones: ${transactions.length}

TRANSACCIONES REGISTRADAS:
${summary}

Genera un informe con estas secciones:
1. RESUMEN EJECUTIVO (2-3 párrafos sobre la situación financiera general)
2. ANÁLISIS DE INGRESOS (fuentes, tendencias, observaciones)
3. ANÁLISIS DE EGRESOS (categorías principales, gastos recurrentes, alertas)
4. BALANCE Y FLUJO DE CAJA (salud financiera, ratio ingresos/egresos)
5. CATEGORÍAS CON MAYOR IMPACTO (top 3 de cada tipo)
6. PLAN DE ADMINISTRACIÓN ÓPTIMA (recomendaciones concretas y accionables para optimizar el capital)
7. ALERTAS Y RIESGOS (si los hay)
8. METAS SUGERIDAS PARA EL PRÓXIMO PERÍODO

Sé específico, directo y práctico. Usa números reales del registro.`

  const result = await model.generateContent(prompt)
  return result.response.text().trim()
}

module.exports = { processTransactionImage, generateFinancialReport }
