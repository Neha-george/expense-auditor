'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { useEffect, useState } from 'react'
import { useRealtime } from '@/providers/RealtimeProvider'
import { LogOut, FileText, CheckCircle, MessageSquare, LayoutDashboard, Database, Scale, Settings, UploadCloud } from 'lucide-react'

export default function Sidebar({ role }: { role: 'employee' | 'admin' }) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const [loggingOut, setLoggingOut] = useState(false)
  const { newClaimsCount } = useRealtime()

  const employeeLinks = [
    { href: '/employee/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/employee/submit', label: 'Submit Claim', icon: FileText },
    { href: '/employee/claims', label: 'My Claims', icon: CheckCircle },
    { href: '/employee/assistant', label: 'Policy Assistant', icon: MessageSquare },
  ]

  const adminLinks = [
    { href: '/admin/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/admin/claims', label: 'Claims Queue', icon: Database },
    { href: '/admin/policies', label: 'Policy Hub', icon: Scale },
    { href: '/admin/spend-limits', label: 'Spend Limits', icon: Settings },
    { href: '/admin/csv', label: 'Bulk Import', icon: UploadCloud },
  ]

  const links = role === 'admin' ? adminLinks : employeeLinks

  const handleLogout = async () => {
    setLoggingOut(true)
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-[220px] flex-col border-r border-zinc-200 bg-white pt-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="px-6 mb-8 flex justify-start items-center">
        <h1 className="text-xl flex gap-1 font-bold tracking-tight text-zinc-950 dark:text-zinc-50">
          <span className="text-blue-600">Policy</span>Lens
        </h1>
      </div>

      <nav className="flex-1 space-y-1 px-4">
        {links.map((link) => {
          const isActive = pathname.startsWith(link.href)
          const Icon = link.icon
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50'
                  : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900/50 dark:hover:text-zinc-50'
              }`}
            >
              <div className="flex items-center gap-3 flex-1">
                <Icon className="h-4 w-4" />
                {link.label}
              </div>
              {link.label === 'Claims Queue' && newClaimsCount > 0 && (
                 <span className="flex h-5 items-center justify-center rounded-full bg-blue-600 px-2 text-xs font-medium text-white shadow-sm transition-all duration-300 transform scale-100 inline-block animate-in pop-in">
                   {newClaimsCount}
                 </span>
              )}
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-500 dark:hover:bg-red-950/50"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </button>
      </div>
    </aside>
  )
}
