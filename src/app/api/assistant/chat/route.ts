import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { embedText } from '@/lib/gemini'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { sendEmail } from '@/lib/email'

export const maxDuration = 60; // Allow longer generation

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

function textResponse(message: string, status = 200) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

function isQuotaOrRateLimitError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err || '')
  const lower = msg.toLowerCase()
  return lower.includes('429') || lower.includes('too many requests') || lower.includes('quota') || lower.includes('rate limit')
}

function buildPolicyFallbackAnswer(message: string, chunks: any[] | null | undefined, activePolicyNames: string[]) {
  const topChunks = (chunks || []).slice(0, 3).map((c: any) => String(c?.content || '').trim()).filter(Boolean)

  if (topChunks.length === 0) {
    return `I could not find a clear policy clause for your question right now.

Question: "${message}"

Please contact your admin for clarification. I have flagged this as a policy-gap query so the policy can be improved.`
  }

  const references = topChunks
    .map((chunk, i) => `Reference ${i + 1}: ${chunk.slice(0, 280)}${chunk.length > 280 ? '...' : ''}`)
    .join('\n\n')

  return `I am temporarily running in fallback mode due to AI quota limits, so I cannot generate a full explanation right now.

Based on active policies (${activePolicyNames.join(', ') || 'current active policies'}), here are the most relevant clauses I found for your question:

${references}

Please use these references for decision-making, or ask your admin for final clarification.`
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError) {
      console.error('Assistant auth error:', authError)
      return textResponse('Authentication service is temporarily unavailable. Please retry.', 503)
    }
    if (!user) return new Response('Unauthorized', { status: 401 })

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, full_name, email, organisation_id')
      .eq('id', user.id)
      .single()

    if (profileError || !profile?.organisation_id) {
      console.error('Assistant profile error:', profileError)
      return textResponse('Unable to validate your organisation context.', 403)
    }

    const orgId = profile.organisation_id

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

    // Resolve active policy list (used for context and admin notifications)
    const { data: activePolicies, error: activePoliciesError } = await supabase
      .from('policy_documents')
      .select('id, name')
      .eq('organisation_id', orgId)
      .eq('is_active', true)

    if (activePoliciesError) throw activePoliciesError

    const activePolicyNames = (activePolicies || []).map((p: any) => p.name)
    const activePolicyCount = activePolicyNames.length

    // RAG: embed question → find relevant active-policy chunks in this org
    const embedding = await embedText(message)
    const matchCount = Math.min(24, Math.max(4, activePolicyCount * 4))
    const { data: chunks } = await admin.rpc('match_policy_chunks', {
      query_embedding: JSON.stringify(embedding),
      match_count: matchCount,
      p_organisation_id: orgId,
    })

    const policyContext = chunks?.length
      ? chunks.map((c: any, i: number) => `[${i + 1}] ${c.content}`).join('\n\n')
      : 'No active policy found.'

    const topSimilarity = Math.max(...(chunks?.map((c: any) => Number(c.similarity || 0)) ?? [0]))
    const isPolicyGap = activePolicyCount > 0 && (chunks?.length ?? 0) === 0 || topSimilarity < 0.6

    if (isPolicyGap) {
      await admin.from('audit_logs').insert({
        organisation_id: orgId,
        actor_id: user.id,
        action: 'policy_gap_query',
        entity_type: 'assistant_query',
        entity_id: crypto.randomUUID(),
        metadata: {
          message,
          active_policy_names: activePolicyNames,
          top_similarity: topSimilarity,
          chunk_count: chunks?.length ?? 0,
        },
      })

      const { data: orgAdmins } = await admin
        .from('profiles')
        .select('email')
        .eq('organisation_id', orgId)
        .eq('role', 'admin')

      const adminEmails = orgAdmins?.map((a: any) => a.email).filter(Boolean) ?? []
      if (adminEmails.length > 0) {
        await sendEmail({
          to: adminEmails,
          subject: 'Policy Gap Detected from Employee Assistant Query',
          html: `
            <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto;">
              <h2>Policy Gap Alert</h2>
              <p>An employee asked a question that appears not to be clearly covered by active policies.</p>
              <ul>
                <li><strong>Employee:</strong> ${profile.full_name || profile.email || user.id}</li>
                <li><strong>Query:</strong> ${message}</li>
                <li><strong>Top Similarity:</strong> ${topSimilarity.toFixed(3)}</li>
                <li><strong>Active Policies:</strong> ${activePolicyNames.join(', ') || 'None'}</li>
              </ul>
              <p>Consider adding or clarifying clauses for this scenario in Policy Hub.</p>
            </div>
          `,
        })
      }
    }

    const systemPrompt = `You are a helpful expense policy assistant for employees.
Answer questions about the company expense policy clearly and concisely.
Base your answers ONLY on the policy excerpts provided.
If the answer is not in the policy, say so honestly.
If no policy excerpt supports the question, explicitly say it is not covered by current policy and advise employee to seek admin clarification.

POLICY EXCERPTS:
${policyContext}`

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: systemPrompt,
    })

    try {
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
    } catch (streamErr: any) {
      console.warn('Assistant stream fallback:', streamErr?.message)
      try {
        const fallback = await model.generateContent(message)
        const text = fallback.response.text()?.trim() || 'I could not generate a response right now. Please try again.'
        return textResponse(text)
      } catch (fallbackErr: any) {
        if (isQuotaOrRateLimitError(fallbackErr)) {
          return textResponse(buildPolicyFallbackAnswer(message, chunks, activePolicyNames))
        }
        throw fallbackErr
      }
    }
  } catch (err: any) {
    console.error('Chat error:', err)
    if (isQuotaOrRateLimitError(err)) {
      return textResponse('AI quota is temporarily exceeded. Please retry in a few minutes.')
    }
    return textResponse('Assistant is temporarily unavailable. Please try again.', 500)
  }
}
