# Receipt Amount Extraction Bug Fix

## Problem
Entertainment bills (and other receipts) were being extracted with amount = ₹0.00, forcing users to manually enter the correct amount. This happened even when the receipt clearly showed the bill amount.

**Example:** A ₹41,000 entertainment bill was extracted as ₹0.00, showing "manual override" at 99% confidence.

## Root Cause
The Gemini OCR extraction prompts were not explicit enough about:
1. Looking specifically for the **FINAL/TOTAL** amount (not subtotals or tax)
2. Handling currency symbols and formatting (₹, commas, decimals)
3. Converting string amounts to numeric values
4. Required fallback behavior when amounts were missed

## Solution
Enhanced the extraction logic in three areas:

### 1. **Improved Prompts** (`src/lib/gemini.ts`)
- Added explicit instructions to look for "TOTAL", "Grand Total", "Amount Due", "Final Amount", "Billed Amount"
- Emphasized extraction of the **bottom-line total**, not subtotals
- Added rules for stripping currency symbols (₹ $ € £) and commas
- Made amount fields **mandatory when receipt is readable** (never null)

**Key changes:**
- `extractReceiptData()`: Added priority order for total field keywords + symbol stripping rules
- `extractReceiptDataBestEffort()`: Added specific guidance for entertainment/hospitality receipts  
- `extractReceiptDataFromText()`: Enhanced to look for TOTAL keywords in text-based receipts (PDFs)

### 2. **Amount Sanitization** (`src/lib/gemini.ts`)
Added post-processing to handle cases where Gemini returns amount as a string:
```typescript
// Convert "₹5000" or "5000.00" to numeric value
if (parsed.amount && typeof parsed.amount === 'string') {
  const numMatch = parsed.amount.toString().replace(/[^0-9.]/g, '')
  parsed.amount = numMatch ? parseFloat(numMatch) : null
}
```

### 3. **Debugging & Logging** (`src/app/api/claims/analyze/route.ts`)
- Added detailed logging when amount extraction fails or returns 0
- Logs include: raw extracted value, type, validation state, and confidence level
- Helps identify if Gemini is returning unexpected formats or if images are truly unreadable

## Files Modified
- `src/lib/gemini.ts`: Enhanced prompts + amount sanitization (3 functions)
- `src/app/api/claims/analyze/route.ts`: Improved amount validation + diagnostic logging

## Expected Behavior After Fix
1. **Entertainment bills** with clearly visible totals will now extract the correct amount
2. **Currency handling** is more robust (₹5000, ₹5,000.00, 5000 INR all normalize to 5000)
3. **Fallback mechanisms** trigger when Gemini extraction is weak:
   - PDF text extraction (for PDFs with extractable text)
   - Best-effort Gemini (different prompt strategy)
   - Local OCR (Tesseract as final fallback)
4. **Diagnostic logs** help identify which extraction method succeeded and why amount was 0

## How to Verify
Submit an entertainment bill (restaurant, bar, hotel) with a clear total amount visible:
1. Amount should now extract correctly instead of showing ₹0.00
2. Manual override should show 99% confidence only if you manually override
3. Server logs will show which extraction method was used

## Related Settings
- `ENABLE_TESSERACT_OCR`: Can be set to true for additional local OCR fallback
- Extraction timeout: 15s for Gemini, 12s for local, 45s for best-effort

## Technical Details
- **Extraction strategy** remains multi-pass: Gemini → PDF text → Best-effort → Local OCR
- **Backward compatible**: No schema changes, existing claims unaffected
- **Zero downtime**: Can be deployed immediately
