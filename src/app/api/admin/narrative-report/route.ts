import { NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { generateContentWithBackoff } from '@/lib/gemini'

type ViolationSummary = {
  label: string
  count: number
}

type EmployeeRiskSummary = {
  alias: string
  flagged_count: number
  total_claims: number
  rejection_rate_pct: number
}

type PolicyGapSummary = {
  message: string
  count: number
  latest_at: string
}

type TrendPoint = {
  week: string
  approval_rate_pct: number
  total_claims: number
}

function toNum(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function sanitizeLine(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function computeWeekKey(dateRaw: string): string {
  const date = new Date(dateRaw)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const firstDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const diffDays = Math.floor((date.getTime() - firstDay.getTime()) / (1000 * 60 * 60 * 24))
  const week = Math.floor(diffDays / 7) + 1
  return `Week ${Math.max(1, Math.min(5, week))}`
}

function buildFallbackNarrative(params: {
  monthLabel: string
  totalSpend: number
  topCategoryLabel: string
  topCategorySpend: number
  approvalRateCurrent: number
  approvalRatePrev: number
  violations: ViolationSummary[]
  flaggedEmployees: EmployeeRiskSummary[]
  policyGaps: PolicyGapSummary[]
}) {
  const overview = `Overview: In ${params.monthLabel}, total submitted spend was INR ${params.totalSpend.toLocaleString('en-IN')} with ${params.topCategoryLabel} as the largest category at INR ${params.topCategorySpend.toLocaleString('en-IN')}. The approval rate is ${params.approvalRateCurrent.toFixed(1)}%, compared with ${params.approvalRatePrev.toFixed(1)}% in the previous month.`

  const riskSignals = `Risk Signals: The most common policy violations were ${params.violations
    .slice(0, 3)
    .map((v) => `${v.label} (${v.count})`)
    .join(', ') || 'not significant this month'}. The highest-risk submitters were ${params.flaggedEmployees
    .slice(0, 3)
    .map((e) => `${e.alias} (${e.flagged_count} flagged/rejected)`)
    .join(', ') || 'not concentrated in a specific employee set'}. Newly observed policy gaps include ${params.policyGaps
    .slice(0, 2)
    .map((g) => sanitizeLine(g.message, 120))
    .join(' | ') || 'no material new gap themes'}.`

  const recommendations = 'Recommendations: Tighten category-level guardrails for recurring exceptions, reinforce manager calibration on borderline approvals, and prioritize policy clause updates for repeated gap queries. Forward-looking recommendation: if current trajectories hold, introduce targeted pre-check nudges and updated policy examples before month-end to reduce flagged volume and improve approval consistency.'

  return `${overview}\n\n${riskSignals}\n\n${recommendations}`
}

function normalizeThreeParagraphNarrative(rawText: string, fallback: string) {
  const source = rawText.trim() || fallback
  const parts = source
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean)

  let p1 = parts[0] || ''
  let p2 = parts[1] || ''
  let p3 = parts.slice(2).join(' ').trim()

  if (!p1 || !p2 || !p3) {
    const fallbackParts = fallback.split(/\n\s*\n/g).filter(Boolean)
    p1 = p1 || fallbackParts[0] || ''
    p2 = p2 || fallbackParts[1] || ''
    p3 = p3 || fallbackParts[2] || ''
  }

  if (!/^overview:/i.test(p1)) p1 = `Overview: ${p1}`
  if (!/^risk signals:/i.test(p2)) p2 = `Risk Signals: ${p2}`
  if (!/^recommendations:/i.test(p3)) p3 = `Recommendations: ${p3}`

  const forwardSentence = 'Forward-looking recommendation: continue tightening pre-check guidance and policy wording this month to lower repeat violations while preserving review quality.'
  if (!/forward-looking recommendation:/i.test(p3)) {
    p3 = `${p3.replace(/[\s.]*$/, '')}. ${forwardSentence}`
  }

  return `${p1}\n\n${p2}\n\n${p3}`
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

export async function POST() {
  try {
    const auth = await requireAdminOrg()
    if (auth.error) return auth.error

    const now = new Date()
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))

    const currentMonthLabel = currentMonthStart.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

    const [{ data: claimsRows, error: claimsError }, { data: gapsRows, error: gapsError }] = await Promise.all([
      auth.admin
        .from('claims')
        .select('id, employee_id, amount, category, status, ai_verdict, ai_reason, policy_reference, created_at')
        .eq('organisation_id', auth.orgId)
        .gte('created_at', prevMonthStart.toISOString())
        .lt('created_at', nextMonthStart.toISOString()),
      auth.admin
        .from('audit_logs')
        .select('metadata, created_at')
        .eq('organisation_id', auth.orgId)
        .eq('action', 'policy_gap_query')
        .gte('created_at', currentMonthStart.toISOString())
        .lt('created_at', nextMonthStart.toISOString()),
    ])

    if (claimsError) throw claimsError
    if (gapsError) throw gapsError

    const claims = claimsRows || []
    const currentMonthClaims = claims.filter((c: any) => new Date(c.created_at) >= currentMonthStart)
    const previousMonthClaims = claims.filter((c: any) => new Date(c.created_at) < currentMonthStart)

    const spendByCategoryMap = new Map<string, number>()
    for (const row of currentMonthClaims) {
      const category = String(row.category || 'other').toLowerCase()
      const amount = toNum(row.amount)
      spendByCategoryMap.set(category, (spendByCategoryMap.get(category) || 0) + amount)
    }

    const spendByCategory = [...spendByCategoryMap.entries()]
      .map(([category, amount]) => ({ category, amount: Number(amount.toFixed(2)) }))
      .sort((a, b) => b.amount - a.amount)

    const totalSpend = spendByCategory.reduce((sum, row) => sum + row.amount, 0)

    const violationMap = new Map<string, number>()
    for (const row of currentMonthClaims) {
      const isViolation = row.status === 'flagged' || row.status === 'rejected' || row.ai_verdict === 'flagged' || row.ai_verdict === 'rejected'
      if (!isViolation) continue

      const label = sanitizeLine(String(row.ai_reason || row.policy_reference || `${row.category || 'other'} policy exception`), 120) || 'policy exception'
      violationMap.set(label, (violationMap.get(label) || 0) + 1)
    }

    const topPolicyViolations: ViolationSummary[] = [...violationMap.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)

    const employeeStats = new Map<string, { flagged: number; total: number }>()
    for (const row of currentMonthClaims) {
      const employeeId = String(row.employee_id || '')
      if (!employeeId) continue
      const existing = employeeStats.get(employeeId) || { flagged: 0, total: 0 }
      existing.total += 1
      if (row.status === 'flagged' || row.status === 'rejected') existing.flagged += 1
      employeeStats.set(employeeId, existing)
    }

    const topFlaggedEmployees: EmployeeRiskSummary[] = [...employeeStats.entries()]
      .map(([employeeId, values]) => ({ employeeId, ...values }))
      .filter((row) => row.flagged > 0)
      .sort((a, b) => b.flagged - a.flagged || b.total - a.total)
      .slice(0, 5)
      .map((row, idx) => ({
        alias: `Employee ${String.fromCharCode(65 + idx)}`,
        flagged_count: row.flagged,
        total_claims: row.total,
        rejection_rate_pct: row.total > 0 ? Number(((row.flagged / row.total) * 100).toFixed(1)) : 0,
      }))

    const policyGapMap = new Map<string, { count: number; latestAt: string }>()
    for (const row of gapsRows || []) {
      const message = sanitizeLine(String((row as any)?.metadata?.message || 'Unspecified policy gap query'), 180)
      const createdAt = String((row as any)?.created_at || now.toISOString())
      const existing = policyGapMap.get(message)
      if (!existing) {
        policyGapMap.set(message, { count: 1, latestAt: createdAt })
      } else {
        existing.count += 1
        if (new Date(createdAt) > new Date(existing.latestAt)) existing.latestAt = createdAt
        policyGapMap.set(message, existing)
      }
    }

    const newPolicyGaps: PolicyGapSummary[] = [...policyGapMap.entries()]
      .map(([message, values]) => ({ message, count: values.count, latest_at: values.latestAt }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    const computeRate = (rows: any[]) => {
      if (rows.length === 0) return 0
      const approved = rows.filter((r) => r.status === 'approved').length
      return (approved / rows.length) * 100
    }

    const approvalRateCurrent = Number(computeRate(currentMonthClaims).toFixed(1))
    const approvalRatePrevious = Number(computeRate(previousMonthClaims).toFixed(1))

    const weeklyMap = new Map<string, { approved: number; total: number }>()
    for (const row of currentMonthClaims) {
      const week = computeWeekKey(row.created_at)
      const bucket = weeklyMap.get(week) || { approved: 0, total: 0 }
      bucket.total += 1
      if (row.status === 'approved') bucket.approved += 1
      weeklyMap.set(week, bucket)
    }

    const approvalRateTrend: TrendPoint[] = [...weeklyMap.entries()]
      .map(([week, values]) => ({
        week,
        approval_rate_pct: values.total > 0 ? Number(((values.approved / values.total) * 100).toFixed(1)) : 0,
        total_claims: values.total,
      }))
      .sort((a, b) => a.week.localeCompare(b.week))

    const structuredInput = {
      month: monthKey(currentMonthStart),
      month_label: currentMonthLabel,
      total_spend: Number(totalSpend.toFixed(2)),
      spend_by_category: spendByCategory,
      top_policy_violations: topPolicyViolations,
      top_flagged_employees: topFlaggedEmployees,
      new_policy_gaps: newPolicyGaps,
      approval_rate_trend: {
        current_month_pct: approvalRateCurrent,
        previous_month_pct: approvalRatePrevious,
        weekly_points: approvalRateTrend,
      },
    }

    const prompt = `You are writing an executive expense narrative for board reporting.
Write exactly 3 paragraphs with these headings:
1) Overview:
2) Risk Signals:
3) Recommendations:

Constraints:
- Use the structured data only.
- Keep each paragraph concise and business-ready.
- Mention major category spend concentration, approval trend, top policy risks, policy-gap signals, and anonymized employee risk concentration.
- The final sentence of paragraph 3 must be forward-looking and start with "Forward-looking recommendation:".
- Do not use bullet points.

Structured data:
${JSON.stringify(structuredInput, null, 2)}`

    const fallbackNarrative = buildFallbackNarrative({
      monthLabel: currentMonthLabel,
      totalSpend,
      topCategoryLabel: spendByCategory[0]?.category || 'other',
      topCategorySpend: spendByCategory[0]?.amount || 0,
      approvalRateCurrent,
      approvalRatePrev: approvalRatePrevious,
      violations: topPolicyViolations,
      flaggedEmployees: topFlaggedEmployees,
      policyGaps: newPolicyGaps,
    })

    let rawNarrative = ''
    try {
      const generated = await generateContentWithBackoff(prompt)
      rawNarrative = generated.response.text().trim()
    } catch (err: any) {
      console.warn('Narrative generation fallback:', err?.message)
      rawNarrative = fallbackNarrative
    }

    const narrative = normalizeThreeParagraphNarrative(rawNarrative, fallbackNarrative)

    await auth.admin.from('audit_logs').insert({
      organisation_id: auth.orgId,
      actor_id: auth.userId,
      action: 'narrative_report_generated',
      entity_type: 'dashboard',
      entity_id: crypto.randomUUID(),
      metadata: {
        month: monthKey(currentMonthStart),
        totals: {
          claims_current_month: currentMonthClaims.length,
          spend_current_month: Number(totalSpend.toFixed(2)),
          approval_rate_current: approvalRateCurrent,
          approval_rate_previous: approvalRatePrevious,
        },
      },
    })

    return NextResponse.json({
      narrative,
      month: monthKey(currentMonthStart),
      org_id: auth.orgId,
      generated_at: new Date().toISOString(),
      structured_input: structuredInput,
    })
  } catch (err: any) {
    console.error('Narrative report error:', err)
    return NextResponse.json({ error: err?.message || 'Failed to generate narrative report' }, { status: 500 })
  }
}
