import dotenv from 'dotenv'
dotenv.config()

import express from 'express'
import mongoose from 'mongoose'
import morgan from 'morgan'
import cors from 'cors'
import Joi from 'joi'
import fetch from 'node-fetch'

const app = express()

const PORT = process.env.PORT || 4000
const MONGO_URI = process.env.MONGO_URI
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'

if (!MONGO_URI) throw new Error('MONGO_URI missing')
await mongoose.connect(MONGO_URI)

// ===== Schemas =====
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true },
  fullname: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  roles: { type: [String], default: ['user'] }
}, { timestamps: true })

const holdingSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  quantity: { type: Number, required: true, min: 0 },
  buyPrice: { type: Number, required: true, min: 0 },
  currentPrice: { type: Number, default: 0 },
  addedAt: { type: Date, default: Date.now }
}, { _id: false })

const portfolioSchema = new mongoose.Schema({
  userUsername: { type: String, required: true, unique: true },
  holdings: { type: [holdingSchema], default: [] }
}, { timestamps: true })

const User = mongoose.model('User', userSchema)
const Portfolio = mongoose.model('Portfolio', portfolioSchema)

// ===== App middleware =====
app.use(cors({ origin: CORS_ORIGIN, credentials: true }))
app.use(express.json())
app.use(morgan('dev'))

// ===== Helpers =====
async function fetchQuote(symbol) {
  const provider = (process.env.QUOTE_PROVIDER || '').toLowerCase()
  try {
    if (provider === 'finnhub' && process.env.FINNHUB_API_KEY) {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${process.env.FINNHUB_API_KEY}`)
      const j = await r.json()
      const px = Number(j.c)
      if (Number.isFinite(px) && px > 0) return px
    }
    if (provider === 'alphavantage' && process.env.ALPHAVANTAGE_API_KEY) {
      const r = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${process.env.ALPHAVANTAGE_API_KEY}`)
      const j = await r.json()
      const px = Number(j?.['Global Quote']?.['05. price'])
      if (Number.isFinite(px) && px > 0) return px
    }
  } catch (e) {
    console.error('quote error', e.message)
  }
  // Dev fallback
  return Number((50 + Math.random() * 150).toFixed(2))
}

function credentialsSchema() {
  return Joi.object({ username: Joi.string().required(), passwordHash: Joi.string().required() })
}

async function verifyUserBody(req, res, next) {
  const username = (req.body?.username || req.header('x-username') || '').trim()
  const passwordHash = (req.body?.passwordHash || req.header('x-passwordhash') || '').trim()
  if (!username || !passwordHash) return res.status(401).json({ error: 'missing credentials', required: ['username', 'passwordHash'] })
  const user = await User.findOne({ username, passwordHash })
  if (!user) return res.status(401).json({ error: 'invalid credentials' })
  req.user = user
  next()
}

// ===== Users =====
const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  passwordHash: Joi.string().min(8).max(200).required(),
  fullname: Joi.string().min(2).max(100).required(),
  username: Joi.string().alphanum().min(3).max(30).required()
})

app.post('/users/register', async (req, res) => {
  const { error, value } = registerSchema.validate(req.body)
  if (error) return res.status(400).json({ error: error.message })

  const exists = await User.findOne({ $or: [{ email: value.email }, { username: value.username }] })
  if (exists) return res.status(409).json({ error: 'email or username exists' })

  const user = await User.create(value)
  await Portfolio.create({ userUsername: user.username, holdings: [] })
  res.json({ id: user._id, email: user.email, fullname: user.fullname, username: user.username, roles: user.roles })
})

app.post('/users/login', async (req, res) => {
  const { error, value } = credentialsSchema().validate(req.body)
  if (error) return res.status(400).json({ error: error.message })
  const user = await User.findOne({ username: value.username, passwordHash: value.passwordHash }).select('email fullname username roles createdAt updatedAt')
  if (!user) return res.status(401).json({ error: 'invalid credentials' })
  res.json({ user })
})

// ===== Portfolio =====
// /portfolio/all: fetch live quotes, update DB, return latest with totals
app.post('/portfolio/all', verifyUserBody, async (req, res) => {
  const p = await Portfolio.findOne({ userUsername: req.user.username })
  if (!p) return res.status(404).json({ error: 'portfolio not found' })

  // Fetch quotes then update each holding
  const symbols = [...new Set(p.holdings.map(h => h.symbol))]
  const quotes = {}
  for (const s of symbols) quotes[s] = await fetchQuote(s)

  for (let h of p.holdings) {
    const q = quotes[h.symbol]
    if (Number.isFinite(q) && q > 0) h.currentPrice = q
  }
  await p.save()

  // Build response with totals
  const holdings = p.holdings.map(h => {
    const gain = h.currentPrice - h.buyPrice
    const gainPercent = h.buyPrice > 0 ? Number(((gain / h.buyPrice) * 100).toFixed(2)) : null
    return { symbol: h.symbol, quantity: h.quantity, buyPrice: h.buyPrice, currentPrice: h.currentPrice, gain: Number(gain.toFixed(2)), gainPercent, addedAt: h.addedAt }
  })
  const totalInvested = p.holdings.reduce((s, h) => s + h.buyPrice * h.quantity, 0)
  const totalCurrent = p.holdings.reduce((s, h) => s + h.currentPrice * h.quantity, 0)
  const pnl = Number((totalCurrent - totalInvested).toFixed(2))
  const pnlPercent = totalInvested > 0 ? Number(((pnl / totalInvested) * 100).toFixed(2)) : null

  res.json({ username: req.user.username, totals: { totalInvested, totalCurrent, pnl, pnlPercent }, holdings })
})

// /portfolio/buy: fetch quote, apply weighted average, update DB
app.post('/portfolio/buy', verifyUserBody, async (req, res) => {
  const schema = Joi.object({ symbol: Joi.string().uppercase().trim().required(), quantity: Joi.number().positive().required() })
  const { error, value } = schema.validate({ symbol: req.body.symbol, quantity: req.body.quantity })
  if (error) return res.status(400).json({ error: 'validation error', details: error.details.map(d => d.message) })

  const p = await Portfolio.findOne({ userUsername: req.user.username })
  if (!p) return res.status(404).json({ error: 'portfolio not found' })

  const symbol = value.symbol
  const qty = value.quantity
  const tradePrice = await fetchQuote(symbol)

  const idx = p.holdings.findIndex(h => h.symbol === symbol)
  if (idx < 0) {
    p.holdings.push({ symbol, quantity: qty, buyPrice: tradePrice, currentPrice: tradePrice, addedAt: new Date() })
  } else {
    const h = p.holdings[idx]
    const newQty = h.quantity + qty
    const newAvg = ((h.buyPrice * h.quantity) + (tradePrice * qty)) / newQty
    h.quantity = newQty
    h.buyPrice = Number(newAvg.toFixed(4))
    h.currentPrice = tradePrice
  }

  await p.save()
  res.json({ ok: true, action: 'buy', symbol, quantity: qty, tradePrice, portfolio: p })
})

// /portfolio/sell: fetch quote, validate qty, update DB
app.post('/portfolio/sell', verifyUserBody, async (req, res) => {
  const schema = Joi.object({ symbol: Joi.string().uppercase().trim().required(), quantity: Joi.number().positive().required() })
  const { error, value } = schema.validate({ symbol: req.body.symbol, quantity: req.body.quantity })
  if (error) return res.status(400).json({ error: 'validation error', details: error.details.map(d => d.message) })

  const p = await Portfolio.findOne({ userUsername: req.user.username })
  if (!p) return res.status(404).json({ error: 'portfolio not found' })

  const symbol = value.symbol
  const qty = value.quantity
  const idx = p.holdings.findIndex(h => h.symbol === symbol)
  if (idx < 0) return res.status(404).json({ error: 'holding not found' })

  const h = p.holdings[idx]
  if (qty > h.quantity) return res.status(400).json({ error: 'sell quantity exceeds holding', holdingQuantity: h.quantity })

  const tradePrice = await fetchQuote(symbol)
  const costBasis = h.buyPrice * qty
  const proceeds = tradePrice * qty
  const realizedPnl = Number((proceeds - costBasis).toFixed(2))

  if (qty === h.quantity) {
    p.holdings.splice(idx, 1)
  } else {
    h.quantity = h.quantity - qty
    h.currentPrice = tradePrice
  }

  await p.save()
  res.json({ ok: true, action: 'sell', symbol, quantity: qty, tradePrice, realizedPnl, portfolio: p })
})

// ===== Start =====
app.listen(PORT, () => {
  console.log(`API on http://localhost:${PORT}`)
})
