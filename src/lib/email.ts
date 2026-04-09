import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY || 'dummy_key')
const SENDER = process.env.SENDER_EMAIL || 'onboarding@resend.dev'

// Wrapper to prevent crashing if keys are missing
export async function sendEmail({ to, subject, html }: { to: string | string[], subject: string, html: string }) {
  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 'dummy_key') {
    console.log(`[Email Mock] To: ${to} | Subject: ${subject}\nHTML: ${html}`)
    return { success: true, mock: true }
  }

  try {
    const data = await resend.emails.send({
      from: `PolicyLens <${SENDER}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    })
    return { success: true, data }
  } catch (error) {
    console.error('Failed to send email:', error)
    return { success: false, error }
  }
}

// 1. Resubmission Request
export const resubmissionTemplate = (name: string, date: string, purpose: string) => `
  <div style="font-family: sans-serif; max-w: 600px; margin: 0 auto;">
    <h2>Receipt Resubmission Required</h2>
    <p>Hi ${name || 'there'},</p>
    <p>We could not process the receipt you uploaded on ${date} for "<strong>${purpose}</strong>". The AI system determined that the image was too blurry or unreadable.</p>
    <p>Please upload a clearer, well-lit photo of the receipt to continue processing this expense.</p>
    <br/>
    <p>Thanks,<br/>The PolicyLens Team</p>
  </div>
`

// 2. Verdict Notification
export const verdictTemplate = (name: string, merchant: string, amount: number, currency: string, verdict: string, aiReason: string, adminNote?: string) => `
  <div style="font-family: sans-serif; max-w: 600px; margin: 0 auto;">
    <h2>Expense Claim ${verdict.toUpperCase()}</h2>
    <p>Hi ${name || 'there'},</p>
    <p>Your recent claim for <strong>${merchant} (${amount} ${currency})</strong> has been marked as <strong>${verdict}</strong>.</p>
    <p><strong>Reasoning:</strong> ${aiReason}</p>
    ${adminNote ? `<p><strong>Admin Note:</strong> ${adminNote}</p>` : ''}
    <br/>
    <p>Thanks,<br/>The PolicyLens Team</p>
  </div>
`

// 3. Submission Confirmation (Queue alert)
export const submissionConfirmationTemplate = (name: string, merchant: string, amount: number, currency: string) => `
  <div style="font-family: sans-serif; max-w: 600px; margin: 0 auto;">
    <h2>Claim Submitted Successfully</h2>
    <p>Hi ${name || 'there'},</p>
    <p>Your claim for <strong>${merchant} (${amount} ${currency})</strong> has been submitted. It has been flagged for manual review by an administrator.</p>
    <p>You will receive an update once the review is completed.</p>
    <br/>
    <p>Thanks,<br/>The PolicyLens Team</p>
  </div>
`

// 4. Admin Flagged Alert
export const adminFlaggedAlertTemplate = (employeeName: string, merchant: string, amount: number, currency: string, reason: string) => `
  <div style="font-family: sans-serif; max-w: 600px; margin: 0 auto;">
    <h2>New Claim Flagged for Review</h2>
    <p>A new claim from <strong>${employeeName || 'An employee'}</strong> requires manual review.</p>
    <ul>
      <li><strong>Merchant:</strong> ${merchant}</li>
      <li><strong>Amount:</strong> ${amount} ${currency}</li>
      <li><strong>AI Assessment:</strong> ${reason}</li>
    </ul>
    <p>Please review this claim in the PolicyLens dashboard.</p>
  </div>
`

// 5. Admin Weekly Digest
export const adminDigestTemplate = (stats: { total: number, flagged: number, leakage: number }) => `
  <div style="font-family: sans-serif; max-w: 600px; margin: 0 auto;">
    <h2>Weekly PolicyLens Digest</h2>
    <p>Here is a summary of the claims processing for the past 7 days:</p>
    <ul>
      <li><strong>Total Claims Processed:</strong> ${stats.total}</li>
      <li><strong>Claims Flagged for Review:</strong> ${stats.flagged}</li>
      <li><strong>Estimated Target Leakage Prevented:</strong> $${stats.leakage.toFixed(2)}</li>
    </ul>
    <br/>
    <p>Have a great week,<br/>The PolicyLens Team</p>
  </div>
`
