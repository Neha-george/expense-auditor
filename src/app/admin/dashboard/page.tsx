'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Activity, AlertTriangle, CheckCircle, DollarSign } from 'lucide-react'

export default function AdminDashboardPage() {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({
    total: 0,
    autoApprovedPct: 0,
    flagged: 0,
    leakagePrevented: 0,
  })
  const [chartData, setChartData] = useState<any[]>([])
  const [offenders, setOffenders] = useState<any[]>([])

  useEffect(() => {
    const fetchDashboard = async () => {
      const supabase = createClient()
      
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      
      const { data: claims, error } = await supabase
        .from('claims')
        .select('*, profiles!claims_employee_id_fkey(full_name)')
        .gte('created_at', thirtyDaysAgo.toISOString())
        
      if (error || !claims) {
        setLoading(false)
        return
      }

      // KPIs
      const total = claims.length
      const flagged = claims.filter(c => c.status === 'flagged').length
      const approved = claims.filter(c => c.status === 'approved' && !c.admin_verdict).length // auto approved
      const autoApprovedPct = total > 0 ? Math.round((approved / total) * 100) : 0
      const leakagePrevented = claims
        .filter(c => c.status === 'rejected')
        .reduce((sum, c) => sum + Number(c.amount || 0), 0)

      setStats({ total, autoApprovedPct, flagged, leakagePrevented })

      // Chart Data (Claims by Category)
      const categories: Record<string, number> = {}
      claims.forEach(c => {
        const cat = c.category || 'other'
        categories[cat] = (categories[cat] || 0) + 1
      })
      const cData = Object.keys(categories).map(k => ({
        name: k.charAt(0).toUpperCase() + k.slice(1),
        count: categories[k]
      }))
      setChartData(cData)

      // Offenders logic
      const userStats: Record<string, { name: string, total: number, violations: number }> = {}
      claims.forEach(c => {
        const name = c.profiles?.full_name || 'Unknown'
        if (!userStats[name]) userStats[name] = { name, total: 0, violations: 0 }
        
        userStats[name].total++
        if (c.status === 'flagged' || c.status === 'rejected') {
          userStats[name].violations++
        }
      })

      const offenderList = Object.values(userStats)
        .map(u => ({
          ...u,
          score: Math.round(((u.total - u.violations) / u.total) * 100)
        }))
        .sort((a, b) => b.violations - a.violations)
        .slice(0, 5)

      setOffenders(offenderList)
      setLoading(false)
    }

    fetchDashboard()
  }, [])

  const formatCurrency = (amt: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amt)
  }

  if (loading) {
    return <div className="p-8 text-center text-zinc-500">Loading dashboard...</div>
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">Dashboard</h1>
        <p className="text-zinc-500 dark:text-zinc-400">Overview of expenses and AI compliance (Last 30 Days).</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between space-y-0 pb-2">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Total Claims</p>
            <Activity className="h-4 w-4 text-zinc-500" />
          </div>
          <div className="text-2xl font-bold">{stats.total}</div>
        </div>
        
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between space-y-0 pb-2">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Auto-Approved</p>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-500">{stats.autoApprovedPct}%</div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between space-y-0 pb-2">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Flagged For Review</p>
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          </div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-500">{stats.flagged}</div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between space-y-0 pb-2">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Leakage Prevented</p>
            <DollarSign className="h-4 w-4 text-blue-500" />
          </div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-500">{formatCurrency(stats.leakagePrevented)}</div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-7">
        
        {/* Chart */}
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 lg:col-span-4">
          <h2 className="text-lg font-semibold mb-6">Claims by Category</h2>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#3f3f46" opacity={0.2} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} fontSize={12} tickMargin={10} />
                <YAxis axisLine={false} tickLine={false} fontSize={12} />
                <Tooltip 
                  cursor={{fill: 'transparent'}}
                  contentStyle={{ borderRadius: '8px', border: '1px solid #e4e4e7', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Bar dataKey="count" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Top Offenders */}
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 lg:col-span-3">
          <h2 className="text-lg font-semibold mb-6">Top Repeat Offenders</h2>
          
          <div className="space-y-4">
            {offenders.length === 0 ? (
              <p className="text-sm text-zinc-500">No violations found in the last 30 days.</p>
            ) : (
              offenders.map((offender, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-zinc-50 border border-zinc-100 dark:bg-zinc-950 dark:border-zinc-800">
                  <div>
                    <p className="font-medium text-sm text-zinc-900 dark:text-zinc-100">{offender.name}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">{offender.violations} violations / {offender.total} claims</p>
                  </div>
                  <div className={`px-2.5 py-1 rounded text-xs font-semibold ${
                    offender.score > 80 ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' :
                    offender.score >= 50 ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400' :
                    'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                  }`}>
                    {offender.score}% Score
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
