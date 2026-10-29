# Answer Key Studio backend

This server handles the real evaluation workflow with Gemini's multimodal API because handwritten PDFs/images must be read before they can be graded.

PowerShell:

```powershell
$env:GEMINI_API_KEY = "your-gemini-api-key"
$env:GEMINI_MODEL = "gemini-3.1-flash-lite"
$env:HOST = "0.0.0.0"
$env:PORT = "3000"
cd "C:\Users\mo562\Documents\Codex\2026-10-29\x20-i\backend"
npm start
```

Open `http://localhost:3000`. The backend serves the website, sends the question paper, answer key, and selected student sheets to Gemini, asks Gemini to analyze every numeric question in Part A and Part B, identifies internal choices and the paper's true total, normalizes final marks to 100, evaluates each uploaded sheet question-by-question, generates recommendations, and appends approved students to the single cumulative file `backend/data/approved/answer-key-evaluation-records.xls`.

Approved records are also retained in `backend/data/answer-key-records.json` so the latest approved evaluation reloads into the dashboard after restarting the server. The cumulative Excel-compatible file includes evaluation ID, subject, student identity, every question mark, final marks, paper total, confidence, and recommendation.

The current frontend file can still be opened directly, but the real backend flow requires the `http://localhost:3000` URL.
