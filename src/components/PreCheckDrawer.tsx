'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronUp, Loader2, MessageSquare, Send, User } from 'lucide-react'
import { createClient } from '@/lib/supabase'

type Likelihood = 'Approved' | 'Likely Flagged' | 'Likely Rejected'

type PrecheckMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  likelihood?: Likelihood
}

type PrecheckSession = {
  summary: string
  messages: PrecheckMessage[]
  updatedAt: string
}

type PreCheckDrawerProps = {
  onPurposeSuggestionChange?: (summary: string) => void
  onSessionChange?: (session: PrecheckSession | null) => void
}

const DEFAULT_MESSAGES: PrecheckMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    createdAt: new Date().toISOString(),
    content:
      'Ask me before you submit: for example, "Can I expense a INR 8000 client dinner for 4 people?" I will give a policy-grounded likelihood and reasoning.',
  },
]

function classifyLikelihood(text: string): Likelihood {
  const lower = text.toLowerCase()
  if (
    lower.includes('likely rejected') ||
    lower.includes('rejected') ||
    lower.includes('not reimbursable') ||
    lower.includes('not allowed')
  ) {
    return 'Likely Rejected'
  }

  if (
    lower.includes('likely flagged') ||
    lower.includes('flagged') ||
    lower.includes('manual review') ||
    lower.includes('manager approval')
  ) {
    return 'Likely Flagged'
  }

  if (
    lower.includes('approved') ||
    lower.includes('reimbursable') ||
    lower.includes('allowed')
  ) {
    return 'Approved'
  }

  return 'Likely Flagged'
}

function derivePurposeSummary(messages: PrecheckMessage[]) {
  const userQueries = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content.trim())
    .filter(Boolean)

  if (!userQueries.length) return ''

  const latest = userQueries[userQueries.length - 1]
    .replace(/^can\s+i\s+expense\s+/i, '')
    .replace(/^can\s+i\s+claim\s+/i, '')
    .replace(/^is\s+it\s+ok\s+to\s+expense\s+/i, '')
    .replace(/[?.!]+$/g, '')
    .trim()

  if (!latest) return ''
  return latest.length > 180 ? `${latest.slice(0, 177)}...` : latest
}

function sessionStorageKey(orgId: string | null, userId: string | null) {
  if (!orgId || !userId) return null
  return `policylens-precheck:${orgId}:${userId}`
}

function confidenceClass(likelihood: Likelihood) {
  if (likelihood === 'Approved') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300'
  }
  if (likelihood === 'Likely Rejected') {
    return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300'
  }
  return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300'
}

export default function PreCheckDrawer({ onPurposeSuggestionChange, onSessionChange }: PreCheckDrawerProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<PrecheckMessage[]>(DEFAULT_MESSAGES)
  const [orgId, setOrgId] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const loadedKeyRef = useRef<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const storageKey = useMemo(() => sessionStorageKey(orgId, userId), [orgId, userId])

  useEffect(() => {
    const loadSession = async () => {
      try {
        const supabase = createClient()
        const { data: auth } = await supabase.auth.getUser()
        const id = auth?.user?.id || null
        setUserId(id)

        if (!id) return

        const { data: profile } = await supabase
          .from('profiles')
          .select('organisation_id')
          .eq('id', id)
          .single()

        setOrgId(profile?.organisation_id || null)
      } catch {
        setOrgId(null)
        setUserId(null)
      }
    }

    void loadSession()
  }, [])

  useEffect(() => {
    if (!storageKey || loadedKeyRef.current === storageKey) return
    loadedKeyRef.current = storageKey

    const raw = localStorage.getItem(storageKey)
    if (!raw) return

    try {
      const parsed = JSON.parse(raw) as PrecheckSession
      if (Array.isArray(parsed?.messages) && parsed.messages.length > 0) {
        setMessages(parsed.messages)
      }
      if (parsed?.summary) {
        onPurposeSuggestionChange?.(parsed.summary)
      }
      onSessionChange?.(parsed)
    } catch {
      // Ignore malformed local session cache.
    }
  }, [onPurposeSuggestionChange, onSessionChange, storageKey])

  useEffect(() => {
    if (!storageKey) return

    const summary = derivePurposeSummary(messages)
    const payload: PrecheckSession = {
      summary,
      messages,
      updatedAt: new Date().toISOString(),
    }

    localStorage.setItem(storageKey, JSON.stringify(payload))
    onSessionChange?.(payload)
    if (summary) onPurposeSuggestionChange?.(summary)
  }, [messages, onPurposeSuggestionChange, onSessionChange, storageKey])

  useEffect(() => {
    if (!open) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  const sendMessage = async () => {
    const trimmed = input.trim()
    if (!trimmed || loading) return

    const userMessage: PrecheckMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    }

    const assistantId = `a-${Date.now() + 1}`
    const assistantPlaceholder: PrecheckMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      likelihood: 'Likely Flagged',
    }

    const historyForRequest = [...messages, userMessage]
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }))

    setMessages((prev) => [...prev, userMessage, assistantPlaceholder])
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/assistant/chat?mode=precheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, history: historyForRequest }),
      })

      if (!res.ok) {
        const errorText = (await res.text()) || 'Failed to get response'
        throw new Error(errorText)
      }

      let fullResponse = ''
      if (res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const text = decoder.decode(value)
          fullResponse += text

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: fullResponse,
                    likelihood: classifyLikelihood(fullResponse),
                  }
                : m
            )
          )
        }
      }
    } catch (err: any) {
      const errorMessage = err?.message || 'Pre-check is temporarily unavailable. Please try again.'
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: errorMessage,
                likelihood: 'Likely Flagged',
              }
            : m
        )
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-40 w-[calc(100vw-2rem)] max-w-md">
      <div className="rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-blue-600" />
            <div>
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Expense Pre-Checker</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Ask before you submit</p>
            </div>
          </div>
          {open ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronUp className="h-4 w-4 text-zinc-500" />}
        </button>

        {open && (
          <div className="border-t border-zinc-200 dark:border-zinc-800">
            <div className="max-h-[52vh] overflow-y-auto px-3 py-3 space-y-4">
              {messages.map((msg) => (
                <div key={msg.id} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300">
                      <Bot className="h-4 w-4" />
                    </div>
                  )}

                  <div className={`max-w-[85%] ${msg.role === 'user' ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
                    {msg.role === 'assistant' && msg.content && (
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${confidenceClass(msg.likelihood || 'Likely Flagged')}`}>
                        {msg.likelihood || 'Likely Flagged'}
                      </span>
                    )}
                    <div
                      className={`rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
                        msg.role === 'user'
                          ? 'bg-blue-600 text-white rounded-tr-sm'
                          : 'bg-zinc-100 text-zinc-900 rounded-tl-sm dark:bg-zinc-800 dark:text-zinc-100'
                      }`}
                    >
                      {msg.content || (loading && msg.role === 'assistant' ? 'Thinking...' : '')}
                    </div>
                  </div>

                  {msg.role === 'user' && (
                    <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                      <User className="h-4 w-4" />
                    </div>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="border-t border-zinc-200 dark:border-zinc-800 p-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void sendMessage()
                }}
                className="relative"
              >
                <textarea
                  rows={2}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Can I expense a INR 8000 client dinner for 4 people?"
                  disabled={loading}
                  className="w-full resize-none rounded-md border border-zinc-300 bg-transparent p-2 pr-11 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950"
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  className="absolute bottom-2 right-2 rounded-md bg-blue-600 p-2 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
