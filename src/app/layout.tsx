import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Toaster } from 'sonner'
import { RealtimeProvider } from '@/providers/RealtimeProvider'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'PolicyLens - Expense Auditing Platform',
  description: 'AI-powered corporate expense auditing platform.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        {/* Anti-FOUC: apply theme before React hydrates */}
        <script dangerouslySetInnerHTML={{ __html: `(function(){var t=localStorage.getItem('theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme:dark)').matches)){document.documentElement.classList.add('dark');}})();` }} />
      </head>
      <body className={inter.className}>
        <RealtimeProvider>
           {children}
           <Toaster position="top-center" richColors />
        </RealtimeProvider>
      </body>
    </html>
  )
}
