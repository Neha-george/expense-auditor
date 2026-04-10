'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { Wallet, Activity, ClipboardCheck, AlertCircle } from 'lucide-react'

export default function EmployeeDashboard() {
  const [metrics, setMetrics] = useState({
    monthlySpend: 0,
    budgetRemaining: 0,
    complianceScore: 100,
    pendingCount: 0
  })
  const [chartData, setChartData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchDashboardData = async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single()
      if (!profile) return

      // Get Start of Month
      const startOfMonth = new Date()
      startOfMonth.setDate(1)
      startOfMonth.setHours(0,0,0,0)

      // Fetch all claims for user
      const { data: claims } = await supabase
        .from('claims')
        .select('id, amount, status, category, created_at')
        .eq('employee_id', user.id)

      // Filter month claims
      const monthClaims = claims?.filter(c => new Date(c.created_at) >= startOfMonth) || []
      
      // Fetch user limits
      const { data: limits } = await supabase
        .from('spend_limits')
        .select('category, monthly_limit')
        .eq('organisation_id', profile.organisation_id)
        .eq('seniority', profile.seniority || 'mid')

      let totalSpend = 0
      let totalLimit = 0
      const categoryMap: Record<string, { spend: number, limit: number }> = {}

      // Initialize map with known categories
      const allCategories = ['meals', 'travel', 'accommodation', 'transport', 'office', 'entertainment', 'other']
      allCategories.forEach(cat => {
        categoryMap[cat] = { spend: 0, limit: 0 }
      })

      // Aggregate Limits
      limits?.forEach(l => {
        if (categoryMap[l.category]) {
          const limitCasted = Number(l.monthly_limit || 0)
          categoryMap[l.category].limit = limitCasted
          totalLimit += limitCasted
        }
      })

      // Aggregate Monthly Spend
      monthClaims.forEach(c => {
        if (c.status === 'approved' || c.status === 'pending') {
           const amt = Number(c.amount || 0)
           totalSpend += amt
           if (categoryMap[c.category]) {
             categoryMap[c.category].spend += amt
           }
        }
      })

      // Metrics map
      const approvedCount = claims?.filter(c => c.status === 'approved').length || 0
      const totalCount = claims?.filter(c => c.status !== 'pending').length || 0 // Exclude pending from adherence historically
      const compliance = totalCount === 0 ? 100 : Math.round((approvedCount / totalCount) * 100)

      setMetrics({
        monthlySpend: totalSpend,
        budgetRemaining: Math.max(0, totalLimit - totalSpend),
        complianceScore: compliance,
        pendingCount: monthClaims.filter(c => c.status === 'pending').length
      })

      // Format for Recharts
      const data = allCategories.map(cat => ({
        name: cat.charAt(0).toUpperCase() + cat.slice(1),
        Spent: categoryMap[cat].spend,
        Limit: categoryMap[cat].limit
      })).filter(d => d.Limit > 0 || d.Spent > 0) // Only show relevant categories

      setChartData(data)
      setLoading(false)
    }

    fetchDashboardData()
  }, [])

  if (loading) {
    return <div className="p-8 text-center text-zinc-500">Loading dashboard...</div>
  }

  const formatCurr = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(n)

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">My Spend Overview</h1>
        <p className="text-zinc-500 dark:text-zinc-400">Track your compliance and remaining budgets for the month.</p>
      </div>

      {/* KPI Row */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-3 text-zinc-500 dark:text-zinc-400 mb-3">
             <Activity className="h-5 w-5" /> <span className="text-sm font-semibold uppercase tracking-wider">Monthly Spend</span>
          </div>
          <p className="text-3xl font-bold">{formatCurr(metrics.monthlySpend)}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-3 text-zinc-500 dark:text-zinc-400 mb-3">
             <Wallet className="h-5 w-5" /> <span className="text-sm font-semibold uppercase tracking-wider">Budget Remaining</span>
          </div>
          <p className="text-3xl font-bold text-green-600 dark:text-green-400">{formatCurr(metrics.budgetRemaining)}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-3 text-zinc-500 dark:text-zinc-400 mb-3">
             <ClipboardCheck className="h-5 w-5" /> <span className="text-sm font-semibold uppercase tracking-wider">Compliance Score</span>
          </div>
          <div className="flex items-end gap-2">
            <p className={`text-3xl font-bold ${metrics.complianceScore < 80 ? 'text-red-500' : 'text-zinc-900 dark:text-white'}`}>
              {metrics.complianceScore}%
            </p>
            <span className="text-sm text-zinc-500 pb-1">historical stats</span>
          </div>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-3 text-zinc-500 dark:text-zinc-400 mb-3">
             <AlertCircle className="h-5 w-5" /> <span className="text-sm font-semibold uppercase tracking-wider">Pending Claims</span>
          </div>
          <p className="text-3xl font-bold">{metrics.pendingCount}</p>
        </div>
      </div>

      {/* Chart Section */}
      <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold mb-6 text-zinc-900 dark:text-zinc-100">Category Budgets vs Actuals</h2>
        
        {chartData.length > 0 ? (
          <div className="h-[350px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#52525b" strokeOpacity={0.2} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#71717a' }} />
                <YAxis tickFormatter={(val) => `$${val}`} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#71717a' }} />
                <Tooltip 
                  cursor={{ fill: 'transparent' }}
                  contentStyle={{ borderRadius: '8px', border: '1px solid #3f3f46', backgroundColor: '#18181b', color: '#fff' }}
                  formatter={(value: any) => [`$${value}`, undefined]}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: '12px', paddingTop: '20px' }} />
                <Bar dataKey="Spent" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={50} />
                <Bar dataKey="Limit" fill="#3f3f46" radius={[4, 4, 0, 0]} maxBarSize={50} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="py-20 text-center text-zinc-500">
            No limits or spend matched for your role this month.
          </div>
        )}
      </div>

    </div>
  )
}
