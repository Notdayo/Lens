import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'

async function fetchAssetVWAP(asset: string): Promise<number | null> {
  const result = await pgPool.query(
    `SELECT
       COALESCE(SUM(price::numeric * base_volume::numeric), 0)
       / NULLIF(SUM(base_volume::numeric), 0) AS vwap
     FROM price_points
     WHERE (asset_a = $1 OR asset_b = $1)
       AND timestamp > NOW() - INTERVAL '5 minutes'`,
    [asset.toUpperCase()]
  )
  const vwap = result.rows[0]?.vwap
  if (vwap === null || vwap === undefined) return null
  return parseFloat(vwap)
}

export async function registerBasketRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { asset?: string | string[]; weight?: string | string[] }
  }>('/basket', async (req, reply) => {
    const rawAssets = req.query.asset
    const rawWeights = req.query.weight

    const assets: string[] = rawAssets
      ? Array.isArray(rawAssets) ? rawAssets : [rawAssets]
      : []
    const weightStrings: string[] = rawWeights
      ? Array.isArray(rawWeights) ? rawWeights : [rawWeights]
      : []

    if (assets.length === 0) {
      return reply.status(400).send({ error: 'At least one asset is required' })
    }
    if (assets.length < 2) {
      return reply.status(400).send({ error: 'Basket requires at least 2 assets' })
    }
    if (assets.length !== weightStrings.length) {
      return reply.status(400).send({ error: 'Number of assets and weights must match' })
    }

    const rawWeightValues = weightStrings.map(w => parseFloat(w))
    if (rawWeightValues.some(w => isNaN(w) || w <= 0)) {
      return reply.status(400).send({ error: 'All weights must be positive numbers' })
    }

    const weightSum = rawWeightValues.reduce((a, b) => a + b, 0)
    const normalizedWeights = rawWeightValues.map(w => w / weightSum)

    const prices = await Promise.all(assets.map(a => fetchAssetVWAP(a)))

    const components = assets.map((asset, i) => ({
      asset: asset.toUpperCase(),
      price: prices[i],
      weight: normalizedWeights[i],
    }))

    const missingAssets = components.filter(c => c.price === null).map(c => c.asset)
    if (missingAssets.length > 0) {
      return reply.status(404).send({ error: `No price data found for: ${missingAssets.join(', ')}` })
    }

    const basketPrice = components.reduce(
      (sum, c) => sum + c.weight * (c.price as number),
      0
    )

    return {
      basketPrice,
      components: components.map(c => ({
        asset: c.asset,
        price: c.price as number,
        weight: parseFloat(c.weight.toFixed(8)),
        contribution: parseFloat((c.weight * (c.price as number)).toFixed(8)),
      })),
      weightSum: parseFloat(normalizedWeights.reduce((a, b) => a + b, 0).toFixed(8)),
      computedAt: new Date().toISOString(),
    }
  })
}
