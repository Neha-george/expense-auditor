import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'

/**
 * GET /api/employee/budget?category=meals
 *
 * Returns the employee's configured monthly spend limit and how much
 * they have already spent this month for the given category.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('seniority, organisation_id')
      .eq('id', user.id)
      .single()

    if (!profile?.organisation_id) {
      return NextResponse.json({ error: 'Organisation not configured' }, { status: 403 })
    }

    const category = request.nextUrl.searchParams.get('category')
    const seniority = profile.seniority || 'mid'
    const orgId = profile.organisation_id

    // If no category passed, return limits for ALL categories
    const categories = [
      'meals', 'travel', 'accommodation', 'transport', 'office', 'entertainment', 'other',
    ]

    const targetCategories = category ? [category] : categories

    // Fetch all relevant limits and current month spend in parallel
    const startOfMonth = new Date()
    startOfMonth.setDate(1)
    startOfMonth.setHours(0, 0, 0, 0)

    const [limitsResult, spendResult] = await Promise.all([
      admin
        .from('spend_limits')
        .select('category, monthly_limit, currency')
        .eq('seniority', seniority)
        .in('category', targetCategories),
      supabase
        .from('claims')
        .select('category, amount')
        .eq('employee_id', user.id)
        .in('category', targetCategories)
        .in('status', ['approved', 'pending'])
        .gte('created_at', startOfMonth.toISOString()),
    ])

    // Aggregate spend per category in JS
    const spendByCategory: Record<string, number> = {}
    for (const row of spendResult.data || []) {
      const cat = row.category as string
      spendByCategory[cat] = (spendByCategory[cat] ?? 0) + Number(row.amount ?? 0)
    }

    const budgetMap: Record<string, { limit: number; spent: number; currency: string }> = {}
    for (const limitRow of limitsResult.data || []) {
      const cat = limitRow.category as string
      budgetMap[cat] = {
        limit: limitRow.monthly_limit,
        spent: spendByCategory[cat] ?? 0,
        currency: limitRow.currency ?? 'INR',
      }
    }

    return NextResponse.json({ budget: budgetMap })
  } catch (err: any) {
    console.error('[Budget API]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
