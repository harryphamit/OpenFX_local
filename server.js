import dotenv from 'dotenv'
dotenv.config()


import express from 'express'
import mongoose from 'mongoose'
import morgan from 'morgan'
import cors from 'cors'
import Joi from 'joi'
import fetch from 'node-fetch'  


const app = express()


const PORT = process.env.PORT
const MONGO_URI = process.env.MONGO_URI
const CORS_ORIGIN = process.env.CORS_ORIGIN


if (!MONGO_URI) throw new Error('MONGO_URI missing')


await mongoose.connect(MONGO_URI)

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
  currentPrice: { type: Number, default: 0 }
}, { _id: false })


const portfolioSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  holdings: { type: [holdingSchema], default: [] }
}, { timestamps: true })


const User = mongoose.model('User', userSchema)
const Portfolio = mongoose.model('Portfolio', portfolioSchema)


app.use(cors({ origin: CORS_ORIGIN, credentials: true }))
app.use(express.json())
app.use(morgan('dev'))

async function verifyUser(req, res, next) {
  const username = req.header('x-username')?.trim()
  const passwordHash = req.header('x-passwordhash')?.trim()
  if (!username || !passwordHash) return res.status(401).json({ error: 'missing credentials' })
  const user = await User.findOne({ username, passwordHash })
  if (!user) return res.status(401).json({ error: 'invalid credentials' })
  req.user = user
  next()
}

// Registration keeps passwordHash as provided
const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  passwordHash: Joi.string().min(8).max(200).required(),
  fullname: Joi.string().min(2).max(100).required(),
  username: Joi.string().alphanum().min(3).max(30).required()
})

// register new user
app.post('/users/register', async (req, res) => {
  const { error, value } = registerSchema.validate(req.body)
  if (error) return res.status(400).json({ error: error.message })
  const exists = await User.findOne({ $or: [{ email: value.email }, { username: value.username }] })
  if (exists) return res.status(409).json({ error: 'email or username exists' })
  const user = await User.create(value)
  await Portfolio.create({ user: user._id, holdings: [] })
  res.json({ id: user._id, email: user.email, fullname: user.fullname, username: user.username, roles: user.roles })
})

// login with username and passwordHash, returns user info without passwordHash
app.post('/users/login', async (req, res) => {
  const schema = Joi.object({ username: Joi.string().required(), passwordHash: Joi.string().required() })
  const { error, value } = schema.validate(req.body)
  if (error) return res.status(400).json({ error: error.message })
  const user = await User.findOne(value).select('email fullname username roles')
  if (!user) return res.status(401).json({ error: 'invalid credentials' })
  res.json({ user })
})

async function fetchQuote(symbol) {
  const price = Number((50 + Math.random() * 150).toFixed(2))
  return price
}

// Portfolio endpoints using header credential check
app.get('/portfolio', verifyUser, async (req, res) => {
  const p = await Portfolio.findOne({ user: req.user._id })
  if (!p) return res.status(404).json({ error: 'portfolio not found' })
  res.json(p)
})


app.post('/portfolio/holdings', verifyUser, async (req, res) => {
  const schema = Joi.object({ symbol: Joi.string().uppercase().trim().required(), quantity: Joi.number().positive().required(), buyPrice: Joi.number().positive().required() })
  const { error, value } = schema.validate(req.body)
  if (error) return res.status(400).json({ error: error.message })


  const p = await Portfolio.findOne({ user: req.user._id })
  if (!p) return res.status(404).json({ error: 'portfolio not found' })


  const i = p.holdings.findIndex(h => h.symbol === value.symbol)
  if (i >= 0) return res.status(409).json({ error: 'symbol exists' })


  const currentPrice = await fetchQuote(value.symbol)
  p.holdings.push({ symbol: value.symbol, quantity: value.quantity, buyPrice: value.buyPrice, currentPrice })
  await p.save()
  res.json(p)
})


app.patch('/portfolio/holdings/:symbol', verifyUser, async (req, res) => {
  const schema = Joi.object({ quantity: Joi.number().min(0), buyPrice: Joi.number().min(0) })
  const { error, value } = schema.validate(req.body)
  if (error) return res.status(400).json({ error: error.message })


  const p = await Portfolio.findOne({ user: req.user._id })
  if (!p) return res.status(404).json({ error: 'portfolio not found' })


  const idx = p.holdings.findIndex(h => h.symbol === req.params.symbol.toUpperCase())
  if (idx < 0) return res.status(404).json({ error: 'holding not found' })


  if (typeof value.quantity === 'number') p.holdings[idx].quantity = value.quantity
  if (typeof value.buyPrice === 'number') p.holdings[idx].buyPrice = value.buyPrice
  await p.save()
  res.json(p)
})


app.delete('/portfolio/holdings/:symbol', verifyUser, async (req, res) => {
  const p = await Portfolio.findOne({ user: req.user._id })
  if (!p) return res.status(404).json({ error: 'portfolio not found' })
  const before = p.holdings.length
  p.holdings = p.holdings.filter(h => h.symbol !== req.params.symbol.toUpperCase())
  if (p.holdings.length === before) return res.status(404).json({ error: 'holding not found' })
  await p.save()
  res.json(p)
})


app.post('/portfolio/refresh', verifyUser, async (req, res) => {
  const p = await Portfolio.findOne({ user: req.user._id })
  if (!p) return res.status(404).json({ error: 'portfolio not found' })
  for (let h of p.holdings) {
    h.currentPrice = await fetchQuote(h.symbol)
  }
  await p.save()
  res.json(p)
})


app.get('/portfolio/summary', verifyUser, async (req, res) => {
  const p = await Portfolio.findOne({ user: req.user._id })
  if (!p) return res.status(404).json({ error: 'portfolio not found' })
  const totalInvested = p.holdings.reduce((s, h) => s + h.buyPrice * h.quantity, 0)
  const totalCurrent = p.holdings.reduce((s, h) => s + h.currentPrice * h.quantity, 0)
  const pnl = Number((totalCurrent - totalInvested).toFixed(2))
  res.json({ totalInvested, totalCurrent, pnl })
})


app.listen(PORT, () => {
  console.log(`API on http://localhost:${PORT}`)
})