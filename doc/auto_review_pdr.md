# Process Design Review (PDR)

## Auto-Review GitHub Bot

| Field | Value |
|---|---|
| Document Status | Draft |
| Version | 1.1 |
| Date | 2026-03-05 |
| Author | Engineering Team |
| Reviewer | — |

---

## 1. Background

Code review adalah salah satu tahap yang paling sering menjadi bottleneck dalam siklus pengembangan perangkat lunak. Proses ini bergantung pada ketersediaan reviewer manusia, yang menyebabkan penundaan pada pipeline deployment.

Auto-Review Bot adalah sistem otomasi berbasis LLM yang diintegrasikan ke dalam GitHub dan Jenkins. Sistem ini menangani review Pull Request, menjawab pertanyaan developer di thread PR, memperbaiki issue secara otomatis, dan menutup issue setelah fix di-merge — tanpa intervensi manual pada setiap langkah.

---

## 2. Scope

### In Scope

- Review otomatis Pull Request menggunakan LLM (Claude / Gemini).
- Pemindaian keamanan terhadap perubahan kode di setiap PR.
- Respon otomatis terhadap komentar developer yang menyebut bot.
- Pembuatan branch, penerapan fix kode oleh LLM, dan pembukaan PR secara otomatis untuk GitHub Issue.
- Penutupan otomatis Issue setelah PR fix di-merge.

### Out of Scope

- Review terhadap PR yang mengubah lebih dari 5.500 baris kode (ditangani secara manual).
- Integrasi dengan platform version control selain GitHub.
- Deployment atau eksekusi kode yang dihasilkan LLM ke environment produksi.

---

## 3. System Architecture

**Diagram 1 — System Architecture**

![Diagram 1 — System Architecture](06_architecture.png)

**Runtime:** Node.js
**LLM Provider:** Claude (default) atau Gemini, dijalankan sebagai child process CLI
**GitHub Integration:** Octokit REST API dengan retry logic (429, 502, 503, 504)
**CI/CD:** Jenkins dengan Generic Webhook Trigger plugin

---

## 4. Flow Routing

Semua event masuk dari GitHub Webhook diarahkan berdasarkan kondisi berikut di `index.js`:

**Diagram 2 — Flow Routing**

![Diagram 2 — Flow Routing](01_flow_routing.png)

| GitHub Action | Kondisi Tambahan | Flow |
|---|---|---|
| `opened`, `synchronize`, `reopened` | — | A — PR Review |
| `created` | Comment berisi `@fei-reviewer` | B — Reply Comment |
| `labeled` | Label = `auto-fix` | C — Auto Fix Issue |
| `labeled` | Label = `auto-review` | D — Manual Re-Review |
| `closed` | `merged = true` | E — Auto Close Issue |

---

## 5. Flow Specifications

### 5.1 Flow A — PR Review

**Trigger:** Pull Request dibuka, disinkronkan, atau dibuka kembali.

**Pre-condition:** Total baris perubahan (additions + deletions) tidak melebihi 5.500.

**Diagram 3 — Flow A: PR Review**

![Diagram 3 — Flow A: PR Review](02_flow_a_review.png)

**Steps:**

1. Periksa ukuran PR via `checkMassivePR()`. Jika melebihi threshold, post notifikasi dan hentikan eksekusi.
2. Jalankan operasi berikut secara paralel:
   - Fetch konteks komentar PR yang sudah ada via `getCommentsContext()`.
   - Jalankan LLM dengan `buildReviewPrompt` untuk menghasilkan hasil review.
   - Jika PR body kosong, jalankan LLM dengan `buildSummaryPrompt` untuk menghasilkan deskripsi PR.
3. Jika summary tersedia, perbarui deskripsi PR.
4. Post atau perbarui komentar review. Idempotency dijaga dengan HTML marker `<!-- auto-review-bot -->`.
5. Jika `SECURITY_SCAN_ENABLED = true`, jalankan pemindaian keamanan:
   - **Critical / High:** Tambahkan label `security-risk`, set commit status `failure`, post laporan keamanan.
   - **Medium / Low:** Hapus label `security-risk`, set commit status `success`, post laporan keamanan.
   - **Clean:** Hapus label `security-risk`, set commit status `success`. Tidak ada komentar.

**Error Handling:** Timeout atau kegagalan LLM diposting sebagai komentar ke PR. Security scan bersifat non-fatal — kegagalan scan tidak menghentikan flow.

---

### 5.2 Flow B — Reply Comment

**Trigger:** Komentar baru di PR yang menyebut `@fei-reviewer`.

**Diagram 4 — Flow B: Reply Comment**

![Diagram 4 — Flow B: Reply Comment](03_flow_b_reply.png)

**Steps:**

1. Abaikan event jika sender adalah bot itu sendiri (pencegahan infinite loop).
2. Fetch konteks komentar via `getCommentsContext()`.
3. Abaikan jika interval antara sekarang dan reply terakhir bot kurang dari 60 detik (rate limiting).
4. Jalankan LLM dengan `buildReplyPrompt`, menyertakan seluruh thread komentar sebagai konteks.
5. Post hasil reply ke PR.

---

### 5.3 Flow C — Auto Fix Issue

**Trigger:** Issue diberi label `auto-fix`.

**Diagram 5 — Flow C: Auto Fix Issue**

![Diagram 5 — Flow C: Auto Fix Issue](04_flow_c_autofix.png)

**Steps:**

1. Fetch metadata issue via `getIssue()`.
2. Validasi konteks issue via LLM (`buildIssueValidationPrompt`). Jika issue tidak memiliki informasi yang cukup (`isValid = false`), post pesan penolakan dan hentikan eksekusi.
3. Periksa idempotency: jika branch `auto-fix/issue-N` sudah memiliki open PR, skip.
4. Tentukan base branch:
   - Jika issue memiliki parent issue dan branch `auto-fix/issue-{parent}` ada di remote, gunakan branch tersebut sebagai base.
   - Fallback ke default branch repository.
5. Setup branch baru via `setupBranch()`.
6. Jalankan LLM dengan `buildIssueFixPrompt` untuk melakukan perubahan kode (Attempt 1).
7. Jika tidak ada perubahan setelah Attempt 1, ulangi dengan `buildIssueFixRetryPrompt` (Attempt 2, prompt lebih eksplisit).
8. Periksa perubahan yang dihasilkan via `getChangedFiles()`. Jika masih tidak ada perubahan, hentikan eksekusi.
9. Generate deskripsi PR via `buildSummaryPrompt`.
10. Commit dan push perubahan via `commitAndPush()`.
11. Buat Pull Request via `createPullRequest()` dengan referensi ke issue (`Resolves #N`).
12. Post link PR ke thread issue.

---

### 5.4 Flow D — Manual Re-Review

**Trigger:** PR diberi label `auto-review`.

**Description:** Memanggil `flowReview()` yang sama dengan Flow A. Digunakan untuk memicu ulang review secara on-demand tanpa memerlukan push commit baru.

---

### 5.5 Flow E — Auto Close Issue

**Trigger:** Pull Request di-merge (`action = closed`, `merged = true`).

**Diagram 6 — Flow E: Auto Close Issue**

![Diagram 6 — Flow E: Auto Close Issue](05_flow_e_autoclose.png)

**Steps:**

1. Periksa apakah `headBranch` cocok dengan pattern `auto-fix/issue-{N}`.
2. Jika cocok, ekstrak nomor issue dan tutup issue tersebut via `closeIssue()` dengan komentar konfirmasi.
3. Jika tidak cocok, tidak ada aksi yang dilakukan.

---

## 6. Supporting Modules

| Module | Responsibility |
|---|---|
| `github.js` | Semua operasi GitHub API (GET/POST PR, Issue, Comment, Label, Status). Menggunakan retry logic dengan exponential backoff untuk HTTP 429, 502, 503, 504. |
| `provider.js` | Menjalankan LLM CLI (claude / gemini) sebagai child process. Timeout: 10 menit. |
| `prompts.js` | Membangun semua prompt LLM: review, reply, fix, fix-retry, validation, summary, security scan. |
| `security.js` | Mem-parse output JSON dari LLM security scan, menentukan level risiko, dan membangun laporan keamanan. |
| `git.js` | Operasi Git melalui shell: `setupBranch`, `getChangedFiles`, `commitAndPush`. |
| `jenkins.js` | Membangun webhook payload dan mengirim HTTP request ke Jenkins Generic Webhook Trigger. |
| `cli.js` | Antarmuka CLI manual untuk menjalankan flow secara lokal: `review`, `fix`, `reply`, `trigger`. |
| `config.js` | Konstanta konfigurasi: threshold baris, label names, bot username, cooldown, model LLM. |

---

## 7. Configuration Reference

| Parameter | Value | Description |
|---|---|---|
| `MASSIVE_PR_LINES` | 5500 | Batas maksimum total perubahan baris per PR |
| `REPLY_COOLDOWN_MS` | 60000 | Interval minimum antar reply bot (ms) |
| `BOT_USERNAME` | `fei-reviewer` | Username bot di GitHub |
| `BOT_MENTION` | `@fei-reviewer` | String mention yang memicu Flow B |
| `AUTO_FIX_LABEL` | `auto-fix` | Label yang memicu Flow C |
| `AUTO_REVIEW_LABEL` | `auto-review` | Label yang memicu Flow D |
| `SECURITY_SCAN_ENABLED` | `true` | Aktifkan/nonaktifkan pemindaian keamanan |
| `SECURITY_RISK_LABEL` | `security-risk` | Label yang ditambahkan saat ditemukan risiko tinggi |
| `SECURITY_BLOCK_ON` | `['critical', 'high']` | Level risiko yang menyebabkan commit status `failure` |
| `GEMINI_MODEL` | `gemini-3.1-pro-preview` | Model Gemini yang digunakan |

---

## 8. Key Design Decisions

### 8.1 Idempotency

- Flow A: Satu komentar review per PR. Bot mendeteksi komentar yang sudah ada via HTML marker dan melakukan update, bukan membuat komentar baru.
- Flow C: Satu PR per issue. Eksekusi dihentikan jika branch `auto-fix/issue-N` sudah memiliki open PR.

### 8.2 Dry-Run Mode

Tersedia di semua flow melalui flag `--dry-run`. Saat aktif, semua operasi write ke GitHub dan Git dinonaktifkan. LLM tetap dijalankan untuk keperluan validasi output.

### 8.3 Sub-Issue Support

Flow C mendukung hierarki issue. Jika suatu issue adalah sub-issue dari issue lain, branch fix akan dibuat dari branch `auto-fix/issue-{parent}` (jika tersedia di remote), bukan dari default branch.

### 8.4 Dual LLM Provider

Bot mendukung dua provider: Claude (default) dan Gemini. Provider dipilih via flag `--provider` saat pemanggilan. Provider dieksekusi sebagai CLI subprocess, bukan melalui API SDK.

---

## 9. Error Handling Summary

| Scenario | Behavior |
|---|---|
| PR melebihi 5.500 baris | Post warning ke PR, flow dihentikan |
| LLM timeout (> 10 menit) | Post timeout notice ke PR/Issue |
| LLM error | Post error message ke PR/Issue |
| Issue tidak memiliki konteks cukup | Post rejection message, flow dihentikan |
| Git setup branch gagal | Post error ke Issue, flow dihentikan |
| LLM tidak menghasilkan perubahan (setelah 2 attempt) | Post no-changes message, flow dihentikan |
| Security scan gagal | Log warning, flow tetap dilanjutkan (non-fatal) |
| GitHub API rate limit (429) | Retry dengan backoff berdasarkan header `Retry-After` |

---

## 10. Open Questions

| # | Question | Owner | Status |
|---|---|---|---|
| 1 | Apakah threshold 5.500 baris sudah optimal untuk semua jenis repository di organisasi? | Engineering | Open |
| 2 | Model LLM mana yang memberikan hasil review lebih akurat untuk codebase yang ada? | Engineering | Open |
| 3 | Apakah perlu mekanisme approval sebelum PR auto-fix di-merge? | Engineering / Product | Open |

---

## 11. Diagram Reference

| # | Diagram | File |
|---|---|---|
| 1 | System Architecture | `06_architecture.png` |
| 2 | Flow Routing | `01_flow_routing.png` |
| 3 | Flow A: PR Review | `02_flow_a_review.png` |
| 4 | Flow B: Reply Comment | `03_flow_b_reply.png` |
| 5 | Flow C: Auto Fix Issue | `04_flow_c_autofix.png` |
| 6 | Flow E: Auto Close Issue | `05_flow_e_autoclose.png` |

---

## 12. Revision History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2026-03-05 | Engineering Team | Initial draft |
| 1.1 | 2026-03-05 | Engineering Team | Added flow diagrams and architecture diagram |
