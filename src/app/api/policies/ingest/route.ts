import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { embedBatch, generatePolicyHealthReport } from '@/lib/gemini'

// Chunk text into ~400-token pieces with 50-token overlap
function chunkText(text: string, chunkSize = 1600, overlap = 200): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length)
    chunks.push(text.slice(start, end).trim())
    start += chunkSize - overlap
  }
  return chunks.filter(c => c.length > 100)
}

export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    // pdf-parse is a CJS module — in Next.js ESM context the real fn is on .default
    const pdfModule = require('pdf-parse')
    const pdf = (pdfModule.default || pdfModule) as (buf: Buffer) => Promise<{ text: string }>
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()

    // Auth check — admins only
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, organisation_id')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin')
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const orgId = profile?.organisation_id
    if (!orgId) return NextResponse.json({ error: 'No organisation configured' }, { status: 403 })

    const formData = await request.formData()
    const file = formData.get('file') as File
    const name = formData.get('name') as string

    if (!file)
      return NextResponse.json({ error: 'PDF file required' }, { status: 400 })
    if (file.size > 20 * 1024 * 1024)
      return NextResponse.json({ error: 'File too large (max 20MB)' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())

    // Server-side MIME validation via magic bytes
    const hex = buffer.toString('hex', 0, 4).toUpperCase()
    if (!hex.startsWith('25504446'))
      return NextResponse.json({ error: 'Invalid file type. Must be a real PDF.' }, { status: 400 })

    // Upload PDF to Supabase Storage (folder per org)
    const fileName = `${orgId}/${Date.now()}-${file.name}`
    const { error: uploadError } = await admin.storage
      .from('policy-docs')
      .upload(fileName, buffer, { contentType: 'application/pdf' })
    if (uploadError) throw uploadError

    // Parse PDF once so we can both embed and generate policy health insights.
    const parsed = await pdf(buffer)

    let policyAnalysis: any = null
    try {
      policyAnalysis = await generatePolicyHealthReport(parsed.text || '')
    } catch {
      policyAnalysis = {
        status: 'risky',
        score: 60,
        summary: 'Policy health analysis unavailable. Review policy coverage manually.',
        recommended_additions: [],
      }
    }

    // Insert policy_document tagged to this org
    const { data: doc, error: docError } = await admin
      .from('policy_documents')
      .insert({
        organisation_id: orgId,          // ← org-tagged
        name,
        file_path: fileName,
        policy_analysis: policyAnalysis,
        is_active: false,
        uploaded_by: user.id,
      })
      .select().single()
    if (docError) throw docError

    // Parse PDF → chunk → embed
    const chunks = chunkText(parsed.text)
    const embeddings = await embedBatch(chunks)

    // All chunks tagged to this org + document
    const rows = chunks.map((content, i) => ({
      organisation_id: orgId,            // ← org-tagged
      document_id: doc.id,
      chunk_index: i,
      content,
      embedding: JSON.stringify(embeddings[i]),
    }))

    const { error: chunksError } = await admin.from('policy_chunks').insert(rows)
    if (chunksError) throw chunksError

    return NextResponse.json({ success: true, documentId: doc.id, chunks: chunks.length })
  } catch (err: any) {
    console.error('Policy ingest error:', err)
    return NextResponse.json({ error: err.message || 'Ingest failed' }, { status: 500 })
  }
}
