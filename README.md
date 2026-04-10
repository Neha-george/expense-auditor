# PolicyLens: AI-Driven Expense Compliance

**PolicyLens** is a proactive expense auditing platform that uses AI to analyze receipts, project monthly spend, and enforce corporate policies in real-time.

### 🚩 The Problem
Manual expense auditing is slow, prone to oversight, and Reactive. Employees often only discover a policy violation weeks after spending, leading to "budget shock" and administrative friction.

### ✅ The Solution
PolicyLens transforms auditing into a **Proactive** experience. It extracts receipt data instantly, cross-references it against weighted corporate policies via vector search, and warns employees of potential budget breaches *before* they even submit.

---

### 🛠️ Tech Stack
- **Framework**: Next.js 16 (App Router, Server Actions)
- **Frontend**: React 19, Tailwind CSS 4
- **Database**: Supabase (PostgreSQL + pgvector for semantic search)
- **AI**: Google Gemini 2.0 Flash (Vision + RAG Reasoning)
- **Quality**: Canvas API (Client-side blur/darkness detection)
- **PWA**: Offline capture & Background Sync
- **Messaging**: Resend (Transactional alerts)

---

### 🚀 Local Setup Guide

Follow these steps to get PolicyLens running on your machine:

1. **Clone the Repository**
   ```bash
   git clone <repository-url>
   cd "expense auditor"
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Environment Configuration**
   Create a `.env.local` file in the root directory and add:
   ```env
   NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
   GOOGLE_AI_API_KEY=your_gemini_api_key
   ```

4. **Database Setup**
   - Go to your Supabase SQL Editor.
   - Copy and run the contents of [`supabase_setup.sql`](./supabase_setup.sql). This will enable `pgvector`, create tables, and set up Row Level Security.

5. **Data Seeding (Optional)**
   Poppulate the database with sample organizations, policies, and users:
   ```bash
   npm run seed:demo
   ```

6. **Storage Configuration**
   - In Supabase, create a new bucket named `receipts`.
   - Set the bucket to **Public** (required for image rendering in the UI).

7. **Run the Application**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) to see the platform.

---
© 2026 PolicyLens. All rights reserved.
