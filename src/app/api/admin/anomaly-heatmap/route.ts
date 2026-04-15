import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'

type HeatmapCell = {
  department: string
  category: string
  median: number
  current_avg: number
  z_score: number
  claim_count: number
}

type BaselineAggregate = {
  median: number
  stddev: number
  weight: number
}

function round(value: number, digits = 2): number {
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

function toNum(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function normalizeKeyPart(value: unknown, fallback = 'unknown'): string {
  const out = String(value ?? '').trim()
  return out || fallback
}

async function requireAdminOrg() {
  const supabase = await createServerSupabase()
  const admin = createAdminSupabase()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, organisation_id')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  if (!profile.organisation_id) {
    return { error: NextResponse.json({ error: 'No organisation found' }, { status: 403 }) }
  }

  return { admin, userId: user.id, orgId: profile.organisation_id }
}

async function buildHeatmapData(orgId: string) {
  const admin = createAdminSupabase()
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

  const [{ data: baselines, error: baselineError }, { data: claims, error: claimsError }] = await Promise.all([
    admin
      .from('statistical_baselines')
      .select('department, category, median_amount, stddev_amount, sample_size')
      .eq('organisation_id', orgId),
    admin
      .from('claims')
      .select('id, employee_department, category, amount, merchant, status, business_purpose, receipt_date, created_at, requires_review')
      .eq('organisation_id', orgId)
      .not('amount', 'is', null)
      .gte('created_at', ninetyDaysAgo),
  ])

  if (baselineError) throw baselineError
  if (claimsError) throw claimsError

  const baselineMap = new Map<string, BaselineAggregate>()
  for (const row of baselines || []) {
    const department = normalizeKeyPart((row as any).department)
    const category = normalizeKeyPart((row as any).category)
    const key = `${department}||${category}`
    const weight = Math.max(1, toNum((row as any).sample_size))
    const existing = baselineMap.get(key)

    const medianPart = toNum((row as any).median_amount) * weight
    const stddevPart = toNum((row as any).stddev_amount) * weight

    if (!existing) {
      baselineMap.set(key, {
        median: medianPart,
        stddev: stddevPart,
        weight,
      })
    } else {
      existing.median += medianPart
      existing.stddev += stddevPart
      existing.weight += weight
      baselineMap.set(key, existing)
    }
  }

  for (const [key, value] of baselineMap.entries()) {
    baselineMap.set(key, {
      median: value.weight > 0 ? value.median / value.weight : 0,
      stddev: value.weight > 0 ? value.stddev / value.weight : 0,
      weight: value.weight,
    })
  }

  const claimMap = new Map<string, { total: number; count: number }>()
  for (const row of claims || []) {
    const department = normalizeKeyPart((row as any).employee_department)
    const category = normalizeKeyPart((row as any).category)
    const key = `${department}||${category}`
    const amount = toNum((row as any).amount)

    const existing = claimMap.get(key) || { total: 0, count: 0 }
    existing.total += amount
    existing.count += 1
    claimMap.set(key, existing)
  }

  const allKeys = new Set<string>([...baselineMap.keys(), ...claimMap.keys()])

  const cells: HeatmapCell[] = [...allKeys].map((key) => {
    const [department, category] = key.split('||')
    const base = baselineMap.get(key)
    const agg = claimMap.get(key)

    const median = base ? base.median : 0
    const stddev = base ? Math.max(0.0001, base.stddev) : 1
    const claimCount = agg?.count || 0
    const currentAvg = agg && agg.count > 0 ? agg.total / agg.count : 0
    const zScore = claimCount > 0 && base ? (currentAvg - median) / stddev : 0

    return {
      department,
      category,
      median: round(median),
      current_avg: round(currentAvg),
      z_score: round(zScore),
      claim_count: claimCount,
    }
  })

  cells.sort((a, b) => {
    if (a.department === b.department) return a.category.localeCompare(b.category)
    return a.department.localeCompare(b.department)
  })

  return { cells, baselines: baselineMap, claims: claims || [] }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminOrg()
    if (auth.error) return auth.error

    const { cells, baselines, claims } = await buildHeatmapData(auth.orgId)

    const department = request.nextUrl.searchParams.get('department')
    const category = request.nextUrl.searchParams.get('category')

    if (!department || !category) {
      return NextResponse.json({ cells })
    }

    const key = `${normalizeKeyPart(department)}||${normalizeKeyPart(category)}`
    const baseline = baselines.get(key)
    const median = baseline?.median ?? 0
    const stddev = Math.max(0.0001, baseline?.stddev ?? 1)

    const outliers = claims
      .filter((row: any) => normalizeKeyPart(row.employee_department) === normalizeKeyPart(department) && normalizeKeyPart(row.category) === normalizeKeyPart(category))
      .map((row: any) => {
        const amount = toNum(row.amount)
        const z = (amount - median) / stddev
        return {
          id: row.id,
          merchant: row.merchant,
          amount: round(amount),
          status: row.status,
          business_purpose: row.business_purpose,
          receipt_date: row.receipt_date,
          created_at: row.created_at,
          requires_review: !!row.requires_review,
          z_score: round(z),
        }
      })
      .sort((a, b) => Math.abs(b.z_score) - Math.abs(a.z_score))
      .slice(0, 5)

    return NextResponse.json({
      cells,
      outliers,
      selected: {
        department: normalizeKeyPart(department),
        category: normalizeKeyPart(category),
        median: round(median),
      },
    })
  } catch (err: any) {
    console.error('Anomaly heatmap GET error:', err)
    return NextResponse.json({ error: err?.message || 'Failed to load anomaly heatmap' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdminOrg()
    if (auth.error) return auth.error

    const body = await request.json()
    const department = normalizeKeyPart(body?.department)
    const category = normalizeKeyPart(body?.category)

    if (!department || !category) {
      return NextResponse.json({ error: 'department and category are required' }, { status: 400 })
    }

    const { baselines } = await buildHeatmapData(auth.orgId)
    const key = `${department}||${category}`
    const baseline = baselines.get(key)

    if (!baseline) {
      return NextResponse.json({ updated: 0, message: 'No baseline found for selected cell' })
    }

    const median = baseline.median
    const stddev = Math.max(0.0001, baseline.stddev)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

    const admin = createAdminSupabase()
    const { data: rows, error: rowsError } = await admin
      .from('claims')
      .select('id, amount')
      .eq('organisation_id', auth.orgId)
      .eq('employee_department', department)
      .eq('category', category)
      .not('amount', 'is', null)
      .gte('created_at', ninetyDaysAgo)

    if (rowsError) throw rowsError

    const flaggedIds = (rows || [])
      .filter((row: any) => {
        const amount = toNum(row.amount)
        const z = (amount - median) / stddev
        return z > 3
      })
      .map((row: any) => row.id)

    if (flaggedIds.length === 0) {
      return NextResponse.json({ updated: 0, message: 'No outliers above z-score 3 for this cell' })
    }

    const { error: updateError } = await admin
      .from('claims')
      .update({ requires_review: true })
      .in('id', flaggedIds)
      .eq('organisation_id', auth.orgId)

    if (updateError) throw updateError

    await admin.from('audit_logs').insert({
      organisation_id: auth.orgId,
      actor_id: auth.userId,
      action: 'flag_all_outliers',
      entity_type: 'claims',
      entity_id: flaggedIds[0],
      metadata: {
        department,
        category,
        z_threshold: 3,
        flagged_count: flaggedIds.length,
        claim_ids: flaggedIds,
      },
    })

    return NextResponse.json({ updated: flaggedIds.length })
  } catch (err: any) {
    console.error('Anomaly heatmap POST error:', err)
    return NextResponse.json({ error: err?.message || 'Failed to flag outliers' }, { status: 500 })
  }
}
