const { createClient } = require('@supabase/supabase-js')
require('dotenv').config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRole) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const admin = createClient(supabaseUrl, serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const CATEGORIES = ['meals', 'travel', 'accommodation', 'transport', 'office', 'entertainment', 'other']
const SENIORITIES = ['junior', 'mid', 'senior', 'executive']
const DEMO_PREFIX = '[DEMO-SEED]'

function makeEmbedding(seedText) {
  const dim = 768
  const out = new Array(dim).fill(0)
  const source = String(seedText || 'demo')

  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i)
    const slot = (code * 17 + i * 31) % dim
    out[slot] += ((code % 7) + 1) / 10
  }

  let norm = 0
  for (const v of out) norm += v * v
  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1

  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number((out[i] * scale).toFixed(8))
  }

  return out
}

async function seedOrg(orgId, admins, employees) {
  const owner = admins[0] || employees[0]
  if (!owner) return

  console.log(`\nSeeding org ${orgId} ...`)

  // 1) Spend limits
  const limitRows = []
  const baseByCat = {
    meals: 4000,
    travel: 15000,
    accommodation: 12000,
    transport: 3000,
    office: 5000,
    entertainment: 6000,
    other: 2500,
  }

  for (const s of SENIORITIES) {
    const mult = s === 'junior' ? 0.8 : s === 'mid' ? 1 : s === 'senior' ? 1.3 : 1.7
    for (const c of CATEGORIES) {
      limitRows.push({
        organisation_id: orgId,
        seniority: s,
        category: c,
        monthly_limit: Math.round(baseByCat[c] * mult),
        currency: 'INR',
      })
    }
  }

  await admin.from('spend_limits').delete().eq('organisation_id', orgId)
  await admin.from('spend_limits').insert(limitRows)

  // 2) Ensure at least 2 active policies + chunks
  const { data: existingPolicies } = await admin
    .from('policy_documents')
    .select('id, name, is_active')
    .eq('organisation_id', orgId)
    .order('created_at', { ascending: true })

  let policyIds = (existingPolicies || []).map(p => p.id)

  if (policyIds.length < 2) {
    const policyRows = []
    for (let i = policyIds.length; i < 2; i += 1) {
      policyRows.push({
        organisation_id: orgId,
        name: `${DEMO_PREFIX} Policy ${i + 1}`,
        file_path: `${orgId}/demo-policy-${i + 1}.pdf`,
        uploaded_by: owner.id,
        is_active: true,
        policy_analysis: {
          status: 'risky',
          score: 66,
          summary: 'Demo seeded policy health summary.',
          recommended_additions: [
            { title: 'Add meal cap rule', why: 'Improve meal decision consistency', priority: 'high' },
          ],
        },
      })
    }

    if (policyRows.length > 0) {
      const { data: insertedPolicies } = await admin
        .from('policy_documents')
        .insert(policyRows)
        .select('id')
      policyIds = policyIds.concat((insertedPolicies || []).map(p => p.id))
    }
  }

  if (policyIds.length > 0) {
    // Activate first two policies for multi-policy behavior.
    await admin
      .from('policy_documents')
      .update({ is_active: false })
      .eq('organisation_id', orgId)

    await admin
      .from('policy_documents')
      .update({ is_active: true })
      .in('id', policyIds.slice(0, 2))

    // Add chunks if missing for active policies.
    const { data: activePolicies } = await admin
      .from('policy_documents')
      .select('id, name')
      .eq('organisation_id', orgId)
      .eq('is_active', true)

    for (const p of activePolicies || []) {
      const { count } = await admin
        .from('policy_chunks')
        .select('*', { count: 'exact', head: true })
        .eq('organisation_id', orgId)
        .eq('document_id', p.id)

      if ((count || 0) < 3) {
        const chunks = [
          `Client meals are reimbursable up to INR 4000 per meal with valid GST bill and business purpose.`,
          `Local travel including taxi and ride-share is reimbursable when linked to business meetings and with receipt evidence.`,
          `Office supplies are reimbursable up to INR 5000 per month for approved roles with manager acknowledgment.`,
        ]

        const rows = chunks.map((content, i) => ({
          organisation_id: orgId,
          document_id: p.id,
          chunk_index: i,
          content,
          embedding: JSON.stringify(makeEmbedding(`${p.id}-${content}`)),
        }))

        await admin.from('policy_chunks').insert(rows)
      }
    }
  }

  // 3) Clean old demo claims, then insert synchronized claims across employees
  const { data: oldClaims } = await admin
    .from('claims')
    .select('id')
    .eq('organisation_id', orgId)
    .ilike('business_purpose', `${DEMO_PREFIX}%`)

  const oldIds = (oldClaims || []).map(c => c.id)
  if (oldIds.length > 0) {
    await admin.from('claims').delete().in('id', oldIds)
  }

  const employeePool = employees.length > 0 ? employees : admins
  const aiVerdicts = ['approved', 'flagged', 'rejected', 'approved']
  const merchants = ['Urban Spice Bistro', 'FastCab', 'SkyRail', 'Office Stationery', 'City Stay Hotel']
  const categories = ['meals', 'transport', 'travel', 'office', 'accommodation']

  const claimRows = []
  for (let i = 0; i < employeePool.length; i += 1) {
    const emp = employeePool[i]
    for (let j = 0; j < 4; j += 1) {
      const aiVerdict = aiVerdicts[j % aiVerdicts.length]
      const cat = categories[j % categories.length]
      const amt = [1200, 850, 5400, 2200, 7800][j % 5]
      const isManualOverride = j === 1 // one reviewed override sample per employee
      const status = isManualOverride ? 'approved' : aiVerdict

      claimRows.push({
        organisation_id: orgId,
        employee_id: emp.id,
        employee_department: emp.department || 'Operations',
        employee_seniority: emp.seniority || 'mid',
        location_city: 'Kochi',
        location_country: 'India',
        receipt_url: `https://example.com/demo-receipt-${orgId}-${i}-${j}.png`,
        merchant: merchants[j % merchants.length],
        amount: amt,
        currency: 'INR',
        receipt_date: new Date(Date.now() - (j * 86400000)).toISOString().slice(0, 10),
        category: cat,
        business_purpose: `${DEMO_PREFIX} ${cat} claim by ${emp.full_name || emp.email}`,
        ai_verdict: aiVerdict,
        ai_reason: `Demo AI assessment for ${cat}`,
        policy_reference: 'Demo policy clause reference',
        admin_verdict: isManualOverride ? 'approved' : null,
        admin_note: isManualOverride ? `${DEMO_PREFIX} admin override sample` : null,
        reviewed_by: isManualOverride ? owner.id : null,
        status,
        confidence: aiVerdict === 'approved' ? 0.93 : aiVerdict === 'flagged' ? 0.62 : 0.9,
        requires_review: status === 'flagged',
        is_duplicate_warning: j === 1,
      })
    }
  }

  let insertedClaims = []
  if (claimRows.length > 0) {
    const { data: inserted } = await admin.from('claims').insert(claimRows).select('id')
    insertedClaims = inserted || []
  }

  // 4) Feedback + baselines + gap logs for admin pages
  await admin
    .from('verdict_feedback')
    .delete()
    .eq('organisation_id', orgId)

  if (insertedClaims.length > 0) {
    await admin.from('verdict_feedback').insert([
      {
        organisation_id: orgId,
        claim_id: insertedClaims[0].id,
        category: 'meals',
        amount_range: '200-1000',
        original_ai_verdict: 'flagged',
        admin_verdict: 'approved',
        admin_reason: `${DEMO_PREFIX} Manager approved within exception policy`,
      },
    ])
  }

  await admin
    .from('statistical_baselines')
    .upsert([
      {
        organisation_id: orgId,
        department: 'Operations',
        seniority: 'mid',
        category: 'meals',
        location_country: 'India',
        median_amount: 1350,
        stddev_amount: 420,
        sample_size: 22,
        updated_at: new Date().toISOString(),
      },
      {
        organisation_id: orgId,
        department: 'Operations',
        seniority: 'mid',
        category: 'travel',
        location_country: 'India',
        median_amount: 5200,
        stddev_amount: 1400,
        sample_size: 18,
        updated_at: new Date().toISOString(),
      },
    ], { onConflict: 'organisation_id,department,seniority,category,location_country' })

  await admin.from('audit_logs').insert([
    {
      organisation_id: orgId,
      actor_id: owner.id,
      action: 'policy_gap_query',
      entity_type: 'assistant_query',
      entity_id: crypto.randomUUID(),
      metadata: {
        message: 'Is an INR 8,000 client dinner claimable without manager approval?',
        top_similarity: 0.41,
        chunk_count: 1,
        active_policy_names: ['Demo Policy'],
      },
    },
    {
      organisation_id: orgId,
      actor_id: owner.id,
      action: 'policy_gap_query',
      entity_type: 'assistant_query',
      entity_id: crypto.randomUUID(),
      metadata: {
        message: 'Can personal gadget purchases be reimbursed for remote work?',
        top_similarity: 0.29,
        chunk_count: 0,
        active_policy_names: ['Demo Policy'],
      },
    },
  ])

  console.log(`Seeded org ${orgId}: claims=${claimRows.length}, employees=${employeePool.length}`)
}

async function ensureDemoEmployees(orgId, admins, employees) {
  const targetCount = 3
  const existing = employees.length
  if (existing >= targetCount) return employees

  const createdEmails = []
  const shortOrg = String(orgId).slice(0, 8)

  for (let i = existing + 1; i <= targetCount; i += 1) {
    const email = `demo.employee${i}.${shortOrg}@policylens.local`
    const fullName = `Demo Employee ${i}`

    const { error: createErr } = await admin.auth.admin.createUser({
      email,
      password: 'password123',
      email_confirm: true,
      user_metadata: { full_name: fullName },
    })

    if (createErr && !String(createErr.message || '').includes('already')) {
      console.warn(`Could not create ${email}:`, createErr.message)
      continue
    }

    createdEmails.push(email)
  }

  if (createdEmails.length > 0) {
    await new Promise((r) => setTimeout(r, 700))
    for (const email of createdEmails) {
      const { data: p } = await admin.from('profiles').select('id').eq('email', email).maybeSingle()
      if (!p?.id) continue
      await admin
        .from('profiles')
        .update({
          organisation_id: orgId,
          role: 'employee',
          onboarding_complete: true,
          department: 'Operations',
          location: 'Kochi, India',
          seniority: 'mid',
        })
        .eq('id', p.id)
    }
  }

  const { data: refreshed } = await admin
    .from('profiles')
    .select('id, email, full_name, role, organisation_id, department, seniority')
    .eq('organisation_id', orgId)
    .eq('role', 'employee')

  return refreshed || employees
}

async function main() {
  console.log('Seeding synchronized demo data for employee/admin views...')

  const { data: profiles, error } = await admin
    .from('profiles')
    .select('id, email, full_name, role, organisation_id, department, seniority')
    .not('organisation_id', 'is', null)

  if (error) {
    console.error('Failed to read profiles:', error.message)
    process.exit(1)
  }

  const byOrg = new Map()
  for (const p of profiles || []) {
    if (!byOrg.has(p.organisation_id)) {
      byOrg.set(p.organisation_id, { admins: [], employees: [] })
    }
    if (p.role === 'admin') byOrg.get(p.organisation_id).admins.push(p)
    else byOrg.get(p.organisation_id).employees.push(p)
  }

  if (byOrg.size === 0) {
    console.log('No registered profiles with organisation_id found. Run scripts/seed_users.ts first.')
    return
  }

  for (const [orgId, members] of byOrg.entries()) {
    const employees = await ensureDemoEmployees(orgId, members.admins, members.employees)
    await seedOrg(orgId, members.admins, employees)
  }

  console.log('\nDemo data seeding complete.')
}

main().catch((e) => {
  console.error('Seed failed:', e)
  process.exit(1)
})
