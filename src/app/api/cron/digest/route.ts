import { NextResponse } from 'next/server'
import { createAdminSupabase } from '@/lib/supabase-server'
import { sendEmail, adminDigestTemplate } from '@/lib/email'

// Optional: Security to ensure only Vercel can trigger this
// We'll rely on the CRON_SECRET if it's set
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminSupabase()
    
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    
    // Fetch claims from the last 7 days
    const { data: claims, error } = await admin
      .from('claims')
      .select('status, amount')
      .gte('created_at', sevenDaysAgo.toISOString())
      
    if (error) throw error

    // Calculate stats
    const total = claims?.length || 0
    const flagged = claims?.filter((c: any) => c.status === 'flagged').length || 0
    const leakage = claims?.filter((c: any) => c.status === 'rejected').reduce((sum: number, c: any) => sum + Number(c.amount || 0), 0) || 0

    const stats = { total, flagged, leakage }

    // Fetch all admins
    const { data: admins } = await admin.from('profiles').select('email').eq('role', 'admin')

    if (admins && admins.length > 0) {
      const adminEmails = admins.map((a: any) => a.email).filter(Boolean)
      if (adminEmails.length > 0) {
        await sendEmail({
          to: adminEmails,
          subject: 'Weekly PolicyLens Digest',
          html: adminDigestTemplate(stats)
        })
      }
    }

    return NextResponse.json({ success: true, stats })
  } catch (err: any) {
    console.error('Digest error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
