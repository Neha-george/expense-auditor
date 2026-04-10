# PolicyLens

PolicyLens is a production-grade, multi-tenant AI expense compliance platform. It automates receipt auditing by comparing claims against organization-specific policies using vector search, statistical risk profiling, and human-in-the-loop reinforcement learning.

## Table Of Contents

1. [Core Features](#core-features)
2. [Functional Depth](#functional-depth)
3. [The Working Pipelines (Minute Details)](#the-working-pipelines-minute-details)
4. [Technology Stack](#technology-stack)
5. [Security & Multi-Tenancy](#security--multi-tenancy)
6. [API Reference](#api-reference)
7. [Operational Notes](#operational-notes)

---

## Core Features

### 🤵 Employee Experience
- **Mobile-First PWA**: Fully responsive interface optimized for on-the-go receipt capture.
- **AI-Assisted Submission**: Upload receipts (JPG, PNG, WebP, PDF) with automated extraction of merchant, amount, date, and category.
- **Policy Assistant Chat**: Real-time RAG-powered chat that answers "Can I claim this?" based on active company policies.
- **Resubmission Flow**: Intelligent tracking of rejected claims with guidance on how to fix compliance issues.

### 🛡️ Admin & Compliance
- **Dynamic Policy Ingestion**: Upload PDF policies which are automatically chunked and indexed into a vector space.
- **Organization Onboarding**: Self-service setup with secure invite codes and role-based access control.
- **Audit Dashboard**: Real-time view of flagged claims, duplicate warnings, and statistical anomalies.
- **GL Account Mapping**: Map expense categories to General Ledger codes for seamless financial reporting.
- **ERP Export Suite**: One-click exports for QuickBooks (IIF), Xero (CSV), and BACS (CSV) formats.

---

## Functional Depth

### 📊 Statistical Risk Profiling (Z-Score)
PolicyLens doesn't just check text; it calculates risk. It maintains a **180-day statistical baseline** for every `{Department, Seniority, Category, City}` cohort.
- **Mathematical Anchor**: Claims are assigned a **Z-Score** ($Z = \frac{x - \mu}{\sigma}$). 
- **Verdicts**: Values $> 3\sigma$ are automatically flagged as anomalies, even if they theoretically meet line-item policy text.

### 🧠 Reinforcement Learning (Human-in-the-loop)
The AI verdict engine "learns" from admin behavior within each organization.
- **Override Calibration**: When an admin overrides an AI decision, the system logs the context in `verdict_feedback`.
- **Few-Shot Prompting**: Subsequent AI analyses for that organization include the last 30 manual overrides as few-shot examples to align AI reasoning with specific corporate culture.

### 💰 Hard Spend Limits
Admins can configure rigid monthly spend caps based on **Seniority** and **Category**. The system performs real-time currency conversion to check available budget before issuing a verdict.

---

## The Working Pipelines (Minute Details)

### 1. Resilient Extraction Pipeline (5-Layer Fallback)
To ensure system availability during AI provider outages or quota limits, the extraction uses a cascaded fallback strategy:
1. **Local Heuristic**: Fast regex/keyword extraction from raw image text (Tesseract.js) or PDF metadata.
2. **Native PDF Extraction**: Direct text stream parsing for PDF files.
3. **Primary Gemini Vision**: High-accuracy structured OCR using `gemini-2.0-flash`.
4. **Best-Effort Vision**: A more permissive prompt for noisy or skewed receipt images.
5. **Heuristic Merge**: A final pass that merges partial results from all layers to prevent null fields.

### 2. Semantic Retrieval (pgvector)
Policy documents are split into semantic chunks and embedded into **768-dimensional vectors**.
- **Indexing**: Uses **HNSW (Hierarchical Navigable Small World)** indexing for sub-millisecond similarity search.
- **Logic**: When a claim is submitted, the system generates a search vector from the category and business purpose, then uses the `match_policy_chunks` RPC to find the top 4 matching clauses within that specific tenant's scope.

### 3. Verdict Engine Logic
Inputs for every decision:
- **Tenant Context**: Organization name and specific override history.
- **Employee Context**: Location, Seniority, and current monthly spend.
- **Risk Context**: Z-score relative to global cohort.
- **Evidence**: Extracted receipt data vs. business purpose.

---

## Technology Stack

- **Framework**: Next.js 16 (App Router)
- **AI**: Google Gemini 2.0 Flash (Vision & Embeddings)
- **Database**: Supabase (PostgreSQL + `pgvector`)
- **Auth**: Supabase Auth (JWT-based Multi-tenancy)
- **Email**: Resend (Transactional alerts & Weekly digests)
- **Styling**: Tailwind CSS 4, Radix UI, Lucide Icons
- **OCR**: Tesseract.js (Local Fallback)

---

## Security & Multi-Tenancy

### Data Isolation (Row Level Security)
The system uses a strictly isolated multi-tenant architecture. 
- **`auth_user_org_id()`**: A database-level helper function that retrieves the tenant ID from the active JWT. 
- **RLS Policies**: Every table (`claims`, `policy_chunks`, `profiles`) enforces isolation such that users can never query or update data outside their `organisation_id`.

### Fraud Detection
The system automatically tags `is_duplicate_warning` by performing a **30-day temporal lookback** for matching `{Employee, Merchant, Amount}` triplets.

---

## API Reference (Key Endpoints)

- `POST /api/claims/analyze`: The core pipeline. Accepts Multipart/FormData (receipt + purpose).
- `POST /api/policies/ingest`: Admin endpoint for PDF vectorization.
- `GET /api/claims/export`: Multi-format generator for ERP systems.
- `POST /api/assistant/chat`: RAG-based policy advisor.
- `GET /api/cron/digest`: Weekly administrative summary generator.

---

## Operational Notes

- **Circuit Breaker**: The system implements an internal "blocked" state for AI providers when 429 (Quota) errors are detected, shifting to deterministic logic for 15 minutes.
- **Currency Handling**: Defaults to **INR** for display, but supports multi-currency extraction and conversion for limit checks.
- **PWA**: Configured via `@ducanh2912/next-pwa` for offline-ready manifest support.

---
© 2026 PolicyLens. All rights reserved.
