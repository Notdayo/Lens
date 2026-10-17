import type { FastifyInstance } from 'fastify'
import { pgPool } from '../db'
import { activeNetwork } from '../config'
import '../middleware/network' // declares req.network on the FastifyRequest type

// Lens has no circulating-supply data, so a market cap cannot be computed. It
// used to be reported as a copy of `liquidity`; a caller who sorts or filters on
// it must be told it is gone rather than have the parameter silently ignored.
const MARKET_CAP_UNSUPPORTED =
  'market_cap is not supported: Lens has no circulating supply data to compute it from. Use liquidity instead'

export async function registerScreenerRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      volume?: string
      change_24h_min?: string
      change_24h_max?: string
      market_cap?: string // rejected with a 400, see MARKET_CAP_UNSUPPORTED
      price_min?: string
      price_max?: string
      liquidity?: string
      sortBy?: string
      order?: string
      cursor?: string
      limit?: string
    }
  }>('/screener', async (req, reply) => {
    try {
      const q = req.query

      // 1. Parse and validate pagination & sorting
      const limit = Math.min(Math.max(parseInt(q.limit ?? '20', 10), 1), 100)
      if (isNaN(limit)) {
        return reply.status(400).send({ error: 'limit must be a valid integer' })
      }

      if (q.market_cap !== undefined || q.sortBy === 'market_cap') {
        return reply.status(400).send({ error: MARKET_CAP_UNSUPPORTED })
      }

      const allowedSortFields = ['volume', 'change_24h', 'price', 'liquidity']
      const sortBy = q.sortBy ?? 'volume'
      if (!allowedSortFields.includes(sortBy)) {
        return reply.status(400).send({ error: `sortBy must be one of: ${allowedSortFields.join(', ')}` })
      }

      const order = (q.order ?? 'desc').toLowerCase()
      if (order !== 'asc' && order !== 'desc') {
        return reply.status(400).send({ error: 'order must be asc or desc' })
      }

      // 2. Parse filters
      const parseNum = (val?: string) => val ? parseFloat(val) : undefined
      const filters = {
        volume: parseNum(q.volume),
        change_24h_min: parseNum(q.change_24h_min),
        change_24h_max: parseNum(q.change_24h_max),
        price_min: parseNum(q.price_min),
        price_max: parseNum(q.price_max),
        liquidity: parseNum(q.liquidity),
      }

      for (const [key, val] of Object.entries(filters)) {
        if (val !== undefined && isNaN(val)) {
          return reply.status(400).send({ error: `Filter ${key} must be a valid number` })
        }
      }

      // 3. Build query parameters and WHERE conditions
      const conditions: string[] = []
      // Every CTE below is scoped to one network: testnet and mainnet rows share
      // these tables, and pooling them would rank a pair on the other chain's data.
      const params: any[] = [req.network ?? activeNetwork]
      let paramIdx = 2

      if (filters.volume !== undefined) {
        conditions.push(`volume >= $${paramIdx++}`)
        params.push(filters.volume)
      }
      if (filters.change_24h_min !== undefined) {
        conditions.push(`change_24h >= $${paramIdx++}`)
        params.push(filters.change_24h_min)
      }
      if (filters.change_24h_max !== undefined) {
        conditions.push(`change_24h <= $${paramIdx++}`)
        params.push(filters.change_24h_max)
      }
      if (filters.price_min !== undefined) {
        conditions.push(`price >= $${paramIdx++}`)
        params.push(filters.price_min)
      }
      if (filters.price_max !== undefined) {
        conditions.push(`price <= $${paramIdx++}`)
        params.push(filters.price_max)
      }
      if (filters.liquidity !== undefined) {
        conditions.push(`liquidity >= $${paramIdx++}`)
        params.push(filters.liquidity)
      }

      // 4. Cursor decoding and pagination condition
      if (q.cursor) {
        try {
          const decoded = Buffer.from(q.cursor, 'base64').toString('utf-8')
          const [lastVal, lastId] = JSON.parse(decoded)
          
          if (lastVal !== null && lastVal !== undefined && lastId) {
            const op = order === 'desc' ? '<' : '>'
            conditions.push(`(${sortBy}, pair_key) ${op} ($${paramIdx++}, $${paramIdx++})`)
            params.push(lastVal, lastId)
          }
        } catch (e) {
          return reply.status(400).send({ error: 'Invalid cursor format' })
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // 5. Construct the full SQL query using CTEs
      const sql = `
        WITH pair_pools AS (
          SELECT DISTINCT pair_key, pool_id 
          FROM price_points 
          WHERE network = $1 AND source = 'AMM' AND pool_id IS NOT NULL
        ),
        latest_snapshots AS (
          SELECT DISTINCT ON (ps.pool_id) 
            ps.pool_id, 
            (ps.reserve_a * ps.spot_price + ps.reserve_b) AS pool_liq
          FROM pool_snapshots ps
          WHERE ps.network = $1
          ORDER BY ps.pool_id, ps.timestamp DESC
        ),
        pair_liquidity AS (
          SELECT pp.pair_key, SUM(ls.pool_liq) AS liquidity
          FROM pair_pools pp
          JOIN latest_snapshots ls ON ls.pool_id = pp.pool_id
          GROUP BY pp.pair_key
        ),
        latest_aggregates AS (
          SELECT DISTINCT ON (pair_key)
            pair_key,
            COALESCE(volume::float, 0) AS volume,
            COALESCE(close_price::float, 0) AS price,
            CASE 
              WHEN open_price > 0 THEN ((close_price::float - open_price::float) / open_price::float) * 100 
              ELSE 0 
            END AS change_24h
          FROM price_aggregates
          WHERE network = $1 AND window = '24h'
          ORDER BY pair_key, bucket DESC
        ),
        screener_data AS (
          SELECT 
            la.pair_key,
            la.volume,
            la.price,
            la.change_24h,
            COALESCE(pl.liquidity::float, 0) AS liquidity
          FROM latest_aggregates la
          LEFT JOIN pair_liquidity pl ON pl.pair_key = la.pair_key
        )
        SELECT * FROM screener_data
        ${whereClause}
        ORDER BY ${sortBy} ${order.toUpperCase()}, pair_key ${order.toUpperCase()}
        LIMIT $${paramIdx}
      `

      // 6. Execute query
      params.push(limit + 1) // Fetch one extra to determine hasMore
      const result = await pgPool.query(sql, params)
      const rows = result.rows

      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows

      // 7. Generate nextCursor
      let nextCursor = null
      if (hasMore && data.length > 0) {
        const lastRecord = data[data.length - 1]
        const cursorPayload = JSON.stringify([lastRecord[sortBy], lastRecord.pair_key])
        nextCursor = Buffer.from(cursorPayload).toString('base64')
      }

      return {
        data,
        nextCursor,
        hasMore,
        total: null,
      }
    } catch (error) {
      console.error('[screener]', error)
      return reply.status(500).send({ error: 'Internal server error' })
    }
  })
}
