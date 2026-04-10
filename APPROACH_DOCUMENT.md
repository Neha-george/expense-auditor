# PolicyLens: Approach & Design Document (v1.1)

## 1. Executive Summary
PolicyLens transforms expense management from a reactive audit-after-fact process into a proactive submission-time guidance system. By integrating real-time Computer Vision (CV) and Retrieval-Augmented Generation (RAG), the platform provides employees with immediate policy feedback while delivering high-integrity, pre-screened claims to administrators.

## 2. Solution Design and Architecture

### 2.1 System Objectives
- Shift-Left Compliance: Catch violations at the moment of upload.
- Operational Efficiency: Reduce manual triage via AI-driven clean claim routing.
- High Availability: Ensure functionality remains active via multi-stage fallbacks during AI provider outages.

### 2.2 End-to-End System Flow

#### Ingestion and Edge Validation
- Native Canvas API: Before the bytes leave the browser, a CV layer checks for darkness, overexposure, and blur (Laplacian variance).
- UX Features: Supports batch-upload queues with real-time status (pending, uploading, done) and a live INR conversion display for instant price transparency.

#### Server-Side Processing Pipeline (/api/claims/analyze)
- Security Gates: Enforces Row-Level Security (RLS) via Supabase, magic-byte MIME validation, and a strict rate limit of 30 calls/user/hour.

#### The Resilient Extraction Stack (5-Layer Fallback)
- L1 (Primary): Gemini 2.0 Flash for structured JSON extraction.
- L2 (PDF Optimized): Stream-based text parsing via pdf-parse.
- L3 (Vision Secondary): Gemini best-effort vision for low-contrast or noisy images.
- L4 (Local Fallback): Tesseract.js plus deterministic heuristic parsing for 99.9% uptime.

#### RAG Verdict Engine
- Semantic Retrieval: Queries pgvector HNSW indexes scoped by organization to find the exact policy clauses.
- AI Verdict: A probabilistic reasoning step (Approved, Flagged, Rejected) accompanied by a citation-linked reason.
- Fast-Verdict Fallback: If the LLM times out, a deterministic rule-based engine provides a preliminary status.

## 3. Tech Stack Rationale

| Component | Choice | Rationale and Impact |
| :--- | :--- | :--- |
| Framework | Next.js 16 + React 19 | Unified full-stack DX; Server Components reduce client-side heavy lifting for AI orchestration. |
| Data and Auth | Supabase (Postgres + pgvector) | Single-platform simplicity for identity, object storage, and vector similarity search. |
| AI Models | Gemini + Local Tesseract | High-tier reasoning from Gemini; local OCR ensures zero-dependency reliability during outages. |
| CV Engine | Browser Canvas API | Offloads pre-processing to the user's device, saving compute costs and reducing failed API calls. |
| Notifications | Resend | Reliable transactional delivery for instant compliance alerts to admins and employees. |

## 4. Operational Features and Trade-offs

### 4.1 Implemented Improvements
- OCR Confidence Scoring: UI renders per-field Confidence Bars (Merchant, Amount, Date) so admins know which values were auto-detected versus manually entered.
- Offline Resilience: Service Workers manage background sync for field users with unstable mobile networks.
- INR Transparency: Automatic conversion of foreign currencies for immediate budget impact assessment.

### 4.2 Current Constraints
- Heuristic Calibration: Confidence scores are currently rule-based (deterministic) rather than statistically calibrated against historical data.
- Sequential Processing: Batch uploads are processed one by one to ensure stability, rather than high-concurrency parallel bursts.
- UI-Only FX: Currency conversion is a UX-layer convenience and is not yet persisted as an immutable, signed audit record.

## 5. Strategic Roadmap (Future Enhancements)
- Audit-Grade FX Hardening: Move currency conversion server-side with signed timestamps for permanent audit replay.
- Hybrid Retrieval: Integrate BM25 keyword matching alongside semantic search to improve accuracy for specific item codes or policy IDs.
- Abuse Controls: Implement cross-tenant duplicate detection and malware scanning within the upload stream.
- Observability Suite: Build a benchmark dashboard tracking Precision and Recall metrics across different receipt categories (Dining versus Travel).

---
Document Version: 1.1.0  
Status: Production Ready  
Engineering Ownership: PolicyLens Core Team
