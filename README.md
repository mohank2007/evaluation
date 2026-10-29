# Answer Key Studio

AI-powered question-by-question evaluation for question papers, answer keys, and handwritten student answer sheets.

## Run locally

1. Set the Gemini API key in the PowerShell session only:

   ```powershell
   $env:GEMINI_API_KEY = "your-gemini-api-key"
   $env:GEMINI_MODEL = "gemini-3.1-flash-lite"
   npm start --prefix backend
   ```

2. Open [http://localhost:3000](http://localhost:3000).

The backend analyzes the complete uploaded paper, including Parts A/B, numeric question numbers, marks, internal choices, concepts, question types, and the paper total. Student sheets are uploaded in batches and evaluated only for the selected range. Approved marks are saved to the cumulative Excel-compatible record file under `backend/data/approved/`.

## Project layout

- `outputs/answer-key-studio.html` — frontend application
- `backend/server.mjs` — Gemini evaluation API and static-file server
- `backend/README.md` — backend setup notes

Generated evaluation records, uploaded-derived logs, and credentials are intentionally ignored by Git so student data and API keys are not published.
