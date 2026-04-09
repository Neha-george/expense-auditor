import { NextResponse } from 'next/server'
import { createAdminSupabase } from '@/lib/supabase-server'
import { sendEmail, adminDigestTemplate } from '@/lib/email'

// Optional: only Vercel cron can call this
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const admin = createAdminSupabase()
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    // Fetch ALL organisations
    const { data: orgs, error: orgsError } = await admin
      .from('organisations')
      .select('id, name')
    if (orgsError) throw orgsError

    const results: Array<{ org: string; stats: object }> = []

    for (const org of orgs ?? []) {
      // Per-org claims stats for last 7 days
      const { data: claims, error: claimsError } = await admin
        .from('claims')
        .select('status, amount')
        .eq('organisation_id', org.id)   // ← isolated per org
        .gte('created_at', sevenDaysAgo.toISOString())

      if (claimsError) {
        console.error(`Digest error for org ${org.id}:`, claimsError)
        continue
      }

      const total   = claims?.length ?? 0
      const flagged = claims?.filter((c: any) => c.status === 'flagged').length ?? 0
      const leakage = claims
        ?.filter((c: any) => c.status === 'rejected')
        .reduce((sum: number, c: any) => sum + Number(c.amount || 0), 0) ?? 0

      const stats = { total, flagged, leakage }

      // Fetch admins for THIS org only
      const { data: admins } = await admin
        .from('profiles')
        .select('email')
        .eq('role', 'admin')
        .eq('organisation_id', org.id)   // ← isolated per org

      const emails = admins?.map((a: any) => a.email).filter(Boolean) ?? []
      if (emails.length > 0) {
        await sendEmail({
          to: emails,
          subject: `Weekly PolicyLens Digest — ${org.name}`,
          html: adminDigestTemplate(stats),
        })
      }

      results.push({ org: org.name, stats })
    }

    return NextResponse.json({ success: true, orgs: results })
  } catch (err: any) {
    console.error('Digest error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
