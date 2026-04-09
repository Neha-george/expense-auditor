'use client'

import { useState, useRef, useEffect } from 'react'
import { Send, User, Bot, Loader2 } from 'lucide-react'

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export default function AssistantPage() {
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', role: 'assistant', content: 'Hello! I am your PolicyLens assistant. You can ask me any questions about our corporate expense policies.' }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || loading) return

    const userMessage: Message = { id: Date.now().toString(), role: 'user', content: input }
    setMessages(prev => [...prev, userMessage])
    setInput('')
    setLoading(true)

    // Add empty assistant message that we will stream into
    const assistantMessageId = (Date.now() + 1).toString()
    setMessages(prev => [...prev, { id: assistantMessageId, role: 'assistant', content: '' }])

    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage.content }),
      })

      if (!res.ok) {
        throw new Error('Failed to get response')
      }

      if (res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let fullResponse = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          
          const text = decoder.decode(value)
          fullResponse += text
          
          setMessages(prev => prev.map(msg => 
            msg.id === assistantMessageId 
              ? { ...msg, content: fullResponse }
              : msg
          ))
        }
      }
    } catch (err: any) {
      console.error(err)
      setMessages(prev => prev.map(msg => 
        msg.id === assistantMessageId 
          ? { ...msg, content: 'Sorry, I encountered an error. Please try again.' }
          : msg
      ))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-80px)]">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-950 dark:text-zinc-50">Policy Assistant</h1>
        <p className="text-zinc-500 dark:text-zinc-400">Ask questions about limits, rules, and procedures based on your active company policy.</p>
      </div>

      <div className="flex-1 rounded-xl border border-zinc-200 bg-white shadow-sm overflow-hidden flex flex-col dark:border-zinc-800 dark:bg-zinc-900">
        
        {/* Messages sequence */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              
              {msg.role === 'assistant' && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300">
                  <Bot className="h-5 w-5" />
                </div>
              )}
              
              <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                msg.role === 'user' 
                  ? 'bg-blue-600 text-white rounded-tr-sm' 
                  : 'bg-zinc-100 text-zinc-900 rounded-tl-sm dark:bg-zinc-800 dark:text-zinc-100'
              }`}>
                {msg.content || (loading && msg.role === 'assistant' ? <span className="animate-pulse">Thinking...</span> : '')}
              </div>

              {msg.role === 'user' && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                  <User className="h-5 w-5" />
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <form onSubmit={handleSend} className="relative flex items-center">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="E.g. What is the limit for client dinners?"
              disabled={loading}
              className="w-full rounded-full border border-zinc-300 pl-4 pr-12 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="absolute right-2 rounded-full p-2 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:bg-zinc-300 transition-colors dark:disabled:bg-zinc-700"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-zinc-500 dark:text-zinc-400" /> : <Send className="h-4 w-4" />}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
