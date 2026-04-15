const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')
const { createClient } = require('@supabase/supabase-js')

dotenv.config({ path: '.env.local' })

async function ensureTestReceipt(filePath) {
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAASwAAABkCAIAAABG3rttAAABMElEQVR4nO3TMQEAIAzAMMC/5yFjRxMFPXpm5gBAz/0OAHwZIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQIEGABAEQBEgQ8AAT9wFrA8iNnQAAAABJRU5ErkJggg=='
  fs.writeFileSync(filePath, Buffer.from(pngBase64, 'base64'))
}

async function run() {
  const baseUrl = 'http://localhost:3000'
  const email = 'employee@globalcorp.local'
  const password = 'password123'

  const receiptPath = path.join(process.cwd(), 'scripts', 'tmp-precheck-receipt.png')
  await ensureTestReceipt(receiptPath)

  const { chromium } = require('playwright')

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  let badgeText = ''
  let purposeValue = ''

  try {
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: 'networkidle' })
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.click('button:has-text("Sign In")')

    await page.waitForTimeout(1500)
    await page.goto(`${baseUrl}/employee/submit`, { waitUntil: 'networkidle' })

    console.log('[debug] submit page URL:', page.url())
    const heading = await page.locator('h1').first().textContent().catch(() => null)
    console.log('[debug] first h1:', heading)
    await page.screenshot({ path: path.join(process.cwd(), 'scripts', 'manual-precheck-submit-page.png'), fullPage: true })

    const drawerToggle = page.locator('button:has-text("Expense Pre-Checker")')
    await drawerToggle.waitFor({ timeout: 20000 })
    await drawerToggle.click()

    const question = 'Can I expense INR 8000 client dinner for 4 people while discussing Q3 renewal opportunities?'
    const chatBox = page.locator('textarea[placeholder*="Can I expense"]')
    await chatBox.fill(question)

    const sendButtons = page.locator('form button[type="submit"]')
    await sendButtons.last().click()

    const badge = page.locator('span', { hasText: /Approved|Likely Flagged|Likely Rejected/ }).first()
    await badge.waitFor({ timeout: 45000 })
    badgeText = (await badge.textContent())?.trim() || ''

    const fileInputs = page.locator('input[type="file"]')
    await fileInputs.first().setInputFiles(receiptPath)

    const purposeArea = page.locator('textarea[placeholder*="Client lunch"]')
    await page.waitForTimeout(1800)
    purposeValue = await purposeArea.inputValue()

    if (!purposeValue || purposeValue.trim().length < 10) {
      throw new Error(`Business purpose was not auto-filled correctly. Current value: "${purposeValue}"`)
    }

    await page.click('button:has-text("Submit Expense")')

    const verdictHeading = page.locator('h3.text-xl.font-bold.capitalize').first()
    await verdictHeading.waitFor({ timeout: 90000 })

    await page.waitForTimeout(1200)
  } finally {
    await browser.close()
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Missing Supabase environment variables in .env.local')
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: actor } = await admin
    .from('profiles')
    .select('id, organisation_id')
    .eq('email', email)
    .single()

  if (!actor?.id || !actor?.organisation_id) {
    throw new Error('Could not resolve actor profile for verification')
  }

  let latest = null
  let hasPayload = false
  let precheckColumnPresent = true
  let verificationNote = null

  const { data: auditRows, error: auditErr } = await admin
    .from('audit_logs')
    .select('id, action, precheck_queries, metadata, created_at')
    .eq('organisation_id', actor.organisation_id)
    .eq('actor_id', actor.id)
    .eq('action', 'precheck_converted_submission')
    .order('created_at', { ascending: false })
    .limit(1)

  if (!auditErr) {
    latest = auditRows?.[0] || null
    hasPayload = Boolean(latest?.precheck_queries && latest.precheck_queries.messages)
  } else if (String(auditErr.message || '').toLowerCase().includes('precheck_queries')) {
    precheckColumnPresent = false
    verificationNote = 'audit_logs.precheck_queries column is missing in this database. Apply migration before payload verification can pass.'

    const { data: fallbackRows, error: fallbackErr } = await admin
      .from('audit_logs')
      .select('id, action, metadata, created_at')
      .eq('organisation_id', actor.organisation_id)
      .eq('actor_id', actor.id)
      .eq('action', 'precheck_converted_submission')
      .order('created_at', { ascending: false })
      .limit(1)

    if (fallbackErr) throw fallbackErr
    latest = fallbackRows?.[0] || null
  } else {
    throw auditErr
  }

  const result = {
    ui: {
      badgeText,
      purposeAutoFilled: purposeValue,
      purposeLength: purposeValue.length,
    },
    audit: latest
      ? {
          id: latest.id,
          action: latest.action,
          created_at: latest.created_at,
          precheck_column_present: precheckColumnPresent,
          has_precheck_queries_payload: hasPayload,
          verification_note: verificationNote,
          precheck_summary: latest.precheck_queries?.summary || latest.metadata?.summary || null,
          precheck_message_count: Array.isArray(latest.precheck_queries?.messages)
            ? latest.precheck_queries.messages.length
            : 0,
          metadata_summary: latest.metadata?.summary || null,
        }
      : null,
  }

  console.log(JSON.stringify(result, null, 2))
}

run().catch((err) => {
  console.error('[manual-precheck-flow] FAILED:', err?.message || err)
  process.exit(1)
})
