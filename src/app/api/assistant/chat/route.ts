import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { embedText } from '@/lib/gemini'
import { GoogleGenerativeAI } from '@google/generative-ai'

export const maxDuration = 60; // Allow longer generation

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return new Response('Unauthorized', { status: 401 })

    // Rate Limiting Check
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count } = await admin
      .from('request_logs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('endpoint', 'chat')
      .gte('created_at', oneHourAgo)

    if ((count ?? 0) >= 30)
      return NextResponse.json({ error: 'Rate limit exceeded. Try again in an hour.' }, { status: 429 })

    await admin.from('request_logs').insert({ user_id: user.id, endpoint: 'chat' })

    const { message } = await request.json()
    if (!message?.trim()) return new Response('Message required', { status: 400 })

    // RAG: embed question → find relevant policy chunks
    const embedding = await embedText(message)
    const { data: chunks } = await admin.rpc('match_policy_chunks', {
      query_embedding: JSON.stringify(embedding),
      match_count: 4,
    })

    const policyContext = chunks?.length
      ? chunks.map((c: any, i: number) => `[${i + 1}] ${c.content}`).join('\n\n')
      : 'No active policy found.'

    const systemPrompt = `You are a helpful expense policy assistant for employees.
Answer questions about the company expense policy clearly and concisely.
Base your answers ONLY on the policy excerpts provided.
If the answer is not in the policy, say so honestly.

POLICY EXCERPTS:
${policyContext}`

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: systemPrompt,
    })

    const result = await model.generateContentStream(message)

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of result.stream) {
            const text = chunk.text()
            if (text) controller.enqueue(new TextEncoder().encode(text))
          }
          controller.close()
        } catch (e) {
          controller.error(e)
        }
      },
    })

    return new Response(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  } catch (err: any) {
    console.error('Chat error:', err)
    return new Response(err.message || 'Chat failed', { status: 500 })
  }
}
