import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase-server'
import { embedBatch } from '@/lib/gemini'
const pdf = require('pdf-parse')

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

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const admin = createAdminSupabase()

    // Auth check — admins only
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await admin
      .from('profiles').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin')
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const formData = await request.formData()
    const file = formData.get('file') as File
    const name = formData.get('name') as string

    if (!file || file.type !== 'application/pdf')
      return NextResponse.json({ error: 'PDF required' }, { status: 400 })
    if (file.size > 20 * 1024 * 1024)
      return NextResponse.json({ error: 'File too large (max 20MB)' }, { status: 400 })

    // Upload PDF to Supabase Storage
    const fileName = `${Date.now()}-${file.name}`
    const buffer = Buffer.from(await file.arrayBuffer())

    const { error: uploadError } = await admin.storage
      .from('policy-docs')
      .upload(fileName, buffer, { contentType: 'application/pdf' })
    if (uploadError) throw uploadError

    // Insert document record
    const { data: doc, error: docError } = await admin
      .from('policy_documents')
      .insert({ name, file_path: fileName, is_active: false, uploaded_by: user.id })
      .select().single()
    if (docError) throw docError

    // Parse PDF text
    const parsed = await pdf(buffer)
    const rawText = parsed.text

    // Chunk text
    const chunks = chunkText(rawText)

    // Embed all chunks
    const embeddings = await embedBatch(chunks)

    // Insert chunks + embeddings
    const rows = chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      embedding: JSON.stringify(embeddings[i]),
    }))

    const { error: chunksError } = await admin
      .from('policy_chunks')
      .insert(rows)
    if (chunksError) throw chunksError

    return NextResponse.json({ success: true, documentId: doc.id, chunks: chunks.length })
  } catch (err: any) {
    console.error('Policy ingest error:', err)
    return NextResponse.json({ error: err.message || 'Ingest failed' }, { status: 500 })
  }
}
