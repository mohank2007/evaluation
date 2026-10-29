import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(ROOT, '..', 'outputs', 'answer-key-studio.html');
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const evaluations = new Map();

const json = (res, code, value) => {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(body);
};

function mimeType(file) {
  if (file.contentType && file.contentType !== 'application/octet-stream') return file.contentType;
  const ext = path.extname(file.filename || '').toLowerCase();
  return ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.txt': 'text/plain' })[ext] || file.contentType || 'application/octet-stream';
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('multipart boundary missing');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  const files = {};
  let offset = 0;
  while (true) {
    const start = body.indexOf(boundary, offset);
    if (start < 0) break;
    const after = start + boundary.length;
    if (body.slice(after, after + 2).toString() === '--') break;
    const partStart = after + 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd < 0) break;
    const headers = body.slice(partStart, headerEnd).toString('utf8');
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    const content = body.slice(headerEnd + 4, next - 2);
    const name = /name="([^"]+)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || 'application/octet-stream';
    if (name) {
      if (filename) {
        const item = { filename, contentType: type, data: content };
        if (files[name]) files[name] = Array.isArray(files[name]) ? [...files[name], item] : [files[name], item];
        else files[name] = item;
      } else fields[name] = content.toString('utf8');
    }
    offset = next;
  }
  return { fields, files };
}

function asArray(value) { return value ? (Array.isArray(value) ? value : [value]) : []; }

function geminiContent(questionPaper, answerKey, sheets) {
  const part = file => ({ inlineData: { mimeType: mimeType(file), data: file.data.toString('base64') } });
  return [{
    role: 'user',
    parts: [
      { text: `You are the assessment evaluator. ${labelText()}\nThe question paper and answer key are authoritative. Do not invent questions, parts, marks, concepts, or student details.` },
      { text: 'QUESTION PAPER (analyze this completely first):' }, part(questionPaper),
      { text: 'ANSWER KEY / RUBRIC:' }, part(answerKey),
      { text: `STUDENT ANSWER SHEETS (${sheets.length} files; evaluate each separately):` },
      ...sheets.flatMap((file, i) => file.data.equals(answerKey.data)
        ? [{ text: `Student sheet ${i + 1}: ${file.filename}. This file is byte-identical to the uploaded answer key above; use the same document content as the student's submitted answers without requiring a second copy.` }]
        : [{ text: `Student sheet ${i + 1}: ${file.filename}` }, part(file)])
    ]
  }];
}

function labelText() {
  return 'First analyze the entire question paper, including its instructions, parts, subparts, marks, internal choices, and any instructions such as answer any N questions. Identify the true paper total, normally 100, and never count both sides of an internal choice toward that total. Return every numeric question and subquestion with its exact part, number, wording/topic, maximum marks, academic concept, and a specific question type such as definition, proof, derivation, computation, construction, interpretation, or application. Concepts and question types must match the actual wording and discipline of each question, such as propositional logic, predicate logic, relation properties, lattice theory, group theory, coding theory, matrix operations, linear transformations, eigenvalues, or inner-product spaces; do not use vague concepts such as general mathematics. Then compare every uploaded student sheet question-by-question against the answer key. Award only marks supported by the key and the question maximum. For each student include a question result for every detected question, mark unanswered or unreadable work as null with feedback, and provide a concise recommendation based only on evaluated gaps and concepts.';
}

const schema = {
  type: 'object', additionalProperties: false, required: ['subject', 'questionMap', 'students'],
  properties: {
    subject: { type: 'string' },
    paperTotalMarks: { type: ['number', 'null'] },
    selectionRules: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ruleId', 'part', 'instruction', 'chooseCount', 'questionNumbers'], properties: { ruleId: { type: 'string' }, part: { type: 'string' }, instruction: { type: 'string' }, chooseCount: { type: ['number', 'null'] }, questionNumbers: { type: 'array', items: { type: 'string' } } } } },
    questionMap: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['part', 'questionNumber', 'questionText', 'maxMarks', 'concept', 'questionType'], properties: { part: { type: 'string' }, questionNumber: { type: 'string' }, questionText: { type: 'string' }, maxMarks: { type: ['number', 'null'] }, concept: { type: 'string' }, questionType: { type: ['string', 'null'] }, choiceGroupId: { type: ['string', 'null'] }, choiceAllowedCount: { type: ['number', 'null'] }, isChoice: { type: 'boolean' } } } },
    students: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fileName', 'studentName', 'rollNumber', 'questions', 'totalMarks', 'maxMarks', 'confidence', 'needsReview'], properties: { fileName: { type: 'string' }, studentName: { type: ['string', 'null'] }, rollNumber: { type: ['string', 'null'] }, questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['part', 'questionNumber', 'awardedMarks', 'maxMarks', 'confidence', 'concept', 'feedback'], properties: { part: { type: 'string' }, questionNumber: { type: 'string' }, awardedMarks: { type: ['number', 'null'] }, maxMarks: { type: ['number', 'null'] }, confidence: { type: 'number' }, concept: { type: 'string' }, feedback: { type: 'string' }, answered: { type: 'boolean' }, counted: { type: 'boolean' }, choiceGroupId: { type: ['string', 'null'] } } } }, totalMarks: { type: ['number', 'null'] }, maxMarks: { type: ['number', 'null'] }, confidence: { type: 'number' }, needsReview: { type: 'boolean' }, recommendation: { type: 'string' } } } }
  }
};

function toGeminiSchema(node) {
  if (!node) return node;
  const typeNames = Array.isArray(node.type) ? node.type : [node.type];
  const type = typeNames.find(value => value !== 'null');
  const typeMap = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', object: 'OBJECT', array: 'ARRAY' };
  const converted = {};
  if (type) converted.type = typeMap[type] || String(type).toUpperCase();
  if (typeNames.includes('null')) converted.nullable = true;
  if (node.description) converted.description = node.description;
  if (node.enum) converted.enum = node.enum;
  if (node.required) converted.required = node.required;
  if (node.minimum !== undefined) converted.minimum = node.minimum;
  if (node.maximum !== undefined) converted.maximum = node.maximum;
  if (node.properties) converted.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
  if (node.items) converted.items = toGeminiSchema(node.items);
  return converted;
}

const geminiResponseSchema = toGeminiSchema(schema);

async function callModel(questionPaper, answerKey, sheets) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured. Set it before starting the backend.');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const response = await fetch(endpoint, { method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: geminiContent(questionPaper, answerKey, sheets), generationConfig: { responseMimeType: 'application/json', responseSchema: geminiResponseSchema } }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Model request failed (${response.status})`);
  const text = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
  if (!text) throw new Error('The evaluator returned no structured result.');
  try { return JSON.parse(text); } catch { return JSON.parse(text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '')); }
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function clampMark(value, maxMarks) {
  if (value === null || value === undefined || value === '') return null;
  const mark = Number(value);
  const max = Number(maxMarks);
  if (!Number.isFinite(mark)) return null;
  return Math.max(0, Math.min(Number.isFinite(max) ? max : mark, mark));
}

function recommendationFor(student) {
  const gaps = (student.questions || []).filter(question => question.counted !== false && (question.awardedMarks === null || question.awardedMarks === undefined || Number(question.awardedMarks) < Number(question.maxMarks)));
  const concepts = [...new Set(gaps.map(question => question.concept).filter(Boolean))].slice(0, 3);
  if (!concepts.length) return 'Maintain current performance and continue practicing mixed questions.';
  return `Review ${concepts.join(', ')}. Rework the missed questions step-by-step, then attempt a fresh practice set on these concepts.`;
}

function inferChoiceGroups(result) {
  const questions = result.questionMap || [];
  const pairs = new Map();
  questions.forEach(question => {
    const match = String(question.questionNumber || '').trim().match(/^(\d+)\s*[.\-]?\s*([ab])$/i);
    if (!match) return;
    const key = `${question.part || ''}|${match[1]}`;
    const pair = pairs.get(key) || [];
    pair.push({ question, suffix: match[2].toLowerCase() });
    pairs.set(key, pair);
  });
  const selectionRules = Array.isArray(result.selectionRules) ? result.selectionRules : [];
  pairs.forEach((pair, key) => {
    const suffixes = new Set(pair.map(item => item.suffix));
    if (pair.length !== 2 || !suffixes.has('a') || !suffixes.has('b')) return;
    const [part, base] = key.split('|');
    const ruleId = `${part || 'Part'}-${base}-choice`;
    pair.forEach(item => {
      item.question.choiceGroupId = ruleId;
      item.question.choiceAllowedCount = 1;
      item.question.isChoice = true;
    });
    if (!selectionRules.some(rule => rule.ruleId === ruleId)) selectionRules.push({ ruleId, part, instruction: `Answer either ${base}a or ${base}b`, chooseCount: 1, questionNumbers: pair.map(item => item.question.questionNumber) });
  });
  result.selectionRules = selectionRules;
  return result;
}

function normalizePaper(result) {
  const declaredTotal = Number(result.paperTotalMarks);
  result.paperTotalMarks = Number.isFinite(declaredTotal) && declaredTotal > 0 && declaredTotal <= 100 ? declaredTotal : 100;
  const rules = Array.isArray(result.selectionRules) ? result.selectionRules : [];
  const ruleByQuestion = new Map();
  rules.forEach(rule => (rule.questionNumbers || []).forEach(number => ruleByQuestion.set(`${rule.part}|${number}`, rule)));
  (result.questionMap || []).forEach(question => {
    const rule = ruleByQuestion.get(`${question.part}|${question.questionNumber}`) || ruleByQuestion.get(`${question.part}|${String(question.questionNumber).replace(/\s+/g, '')}`);
    if (rule && !question.choiceGroupId) {
      question.choiceGroupId = rule.ruleId;
      question.choiceAllowedCount = rule.chooseCount;
      question.isChoice = true;
    }
  });
  return inferChoiceGroups(result);
}

function applyChoiceRules(student, result) {
  const questionMap = result.questionMap || [];
  const maxTotal = result.paperTotalMarks || 100;
  const existing = new Map((student.questions || []).map(question => [`${question.part}|${question.questionNumber}`, question]));
  student.questions = questionMap.map(question => {
    const prior = existing.get(`${question.part}|${question.questionNumber}`) || {};
    return {
      part: question.part,
      questionNumber: question.questionNumber,
      awardedMarks: clampMark(prior.awardedMarks, question.maxMarks),
      maxMarks: Number(question.maxMarks) || null,
      confidence: Number.isFinite(Number(prior.confidence)) ? Number(prior.confidence) : 0,
      concept: question.concept || prior.concept || '',
      feedback: prior.feedback || 'No question-level feedback returned.',
      answered: prior.answered !== false && prior.awardedMarks !== null && prior.awardedMarks !== undefined,
      counted: prior.counted !== false,
      choiceGroupId: question.choiceGroupId || null
    };
  });
  const groups = new Map();
  student.questions.forEach((question, index) => {
    const paperQuestion = questionMap[index];
    if (!paperQuestion.choiceGroupId) return;
    const group = groups.get(paperQuestion.choiceGroupId) || { allowed: Number(paperQuestion.choiceAllowedCount) || 1, items: [] };
    group.allowed = Number(paperQuestion.choiceAllowedCount) || group.allowed;
    group.items.push({ question, index });
    groups.set(paperQuestion.choiceGroupId, group);
  });
  groups.forEach(group => {
    group.items.sort((a, b) => (Number(b.question.awardedMarks) || -1) - (Number(a.question.awardedMarks) || -1));
    group.items.forEach((item, rank) => {
      if (rank >= group.allowed) {
        item.question.awardedMarks = 0;
        item.question.counted = false;
        item.question.feedback = 'Alternative not counted because the question paper requires a limited number of choices from this group.';
      }
    });
  });
  const rawTotal = student.questions.reduce((sum, question) => sum + (question.counted === false ? 0 : (Number(question.awardedMarks) || 0)), 0);
  const exceedsWithoutRules = rawTotal > maxTotal && groups.size === 0;
  student.totalMarks = Math.min(maxTotal, rawTotal);
  student.maxMarks = maxTotal;
  student.needsReview = Boolean(student.needsReview || exceedsWithoutRules || student.questions.some(question => question.awardedMarks === null));
  if (exceedsWithoutRules) student.recommendation = 'The uploaded paper contains more raw question marks than its 100-mark total, but no machine-readable choice rule was returned. Confirm the choice instruction before finalizing this score.';
  else student.recommendation = recommendationFor(student);
  return student;
}

function fillExactDocumentMatch(result, answerKey, selected) {
  const questions = result.questionMap || [];
  result.students = (result.students || []).map((student, index) => {
    const source = selected[index];
    if (source && source.data.equals(answerKey.data) && questions.length) {
      const existing = new Map((student.questions || []).map(question => [`${question.part}|${question.questionNumber}`, question]));
      student.questions = questions.map(question => {
        const prior = existing.get(`${question.part}|${question.questionNumber}`);
        return prior && prior.awardedMarks !== null && prior.awardedMarks !== undefined
          ? { ...prior, maxMarks: question.maxMarks, concept: question.concept }
          : { part: question.part, questionNumber: question.questionNumber, awardedMarks: question.maxMarks, maxMarks: question.maxMarks, confidence: 1, concept: question.concept, feedback: 'Exact match: this student file is byte-identical to the uploaded answer key.', answered: true, counted: true };
      });
      student.confidence = 1;
      student.needsReview = false;
    }
    return applyChoiceRules(student, result);
  });
  return result;
}

function evaluationQuestions(records) {
  const map = new Map();
  records.forEach(record => (record.questionMap || []).forEach(question => map.set(`${question.part}|${question.questionNumber}`, question)));
  return [...map.values()];
}

function normalizeSavedRecords(records) {
  let changed = false;
  const normalized = records.map(record => {
    const before = JSON.stringify(record);
    normalizePaper(record);
    record.students = (record.students || []).map(student => applyChoiceRules(student, record));
    if (JSON.stringify(record) !== before) changed = true;
    return record;
  });
  return { records: normalized, changed };
}

function cumulativeExcelHtml(records) {
  const questions = evaluationQuestions(records);
  const headers = questions.map(question => `<th>${escapeHtml(`${question.part} ${question.questionNumber} (${question.maxMarks ?? '—'})`)}</th>`).join('');
  const rows = records.flatMap(record => (record.students || []).map(student => {
    const cells = questions.map(question => { const result = student.questions?.find(item => item.questionNumber === question.questionNumber && item.part === question.part); return `<td>${result?.counted === false ? 'NC' : (result?.awardedMarks ?? '')}</td>`; }).join('');
    return `<tr><td>${escapeHtml(record.id)}</td><td>${escapeHtml(record.approvedAt || record.createdAt || '')}</td><td>${escapeHtml(record.subject || '')}</td><td>${escapeHtml(student.studentName || '')}</td><td>${escapeHtml(student.rollNumber || '')}</td><td>${escapeHtml(student.fileName || '')}</td>${cells}<td>${student.totalMarks ?? ''}</td><td>${record.paperTotalMarks || 100}</td><td>${student.confidence ?? ''}</td><td>${escapeHtml(student.recommendation || recommendationFor(student))}</td></tr>`;
  })).join('');
  return `<html><head><meta charset="UTF-8"><style>body{font-family:Arial;color:#172033}h2{color:#243b8f}table{border-collapse:collapse;font-size:11px}th,td{border:1px solid #cfd6e4;padding:6px;vertical-align:top}th{background:#eef2ff;color:#172033}td{mso-number-format:"@"}</style></head><body><h2>Answer Key Evaluation Records</h2><p>Scores follow the uploaded paper's mark split and never exceed the paper total. NC means an internal-choice alternative was not counted.</p><table><tr><th>Evaluation ID</th><th>Approved at</th><th>Subject</th><th>Student name</th><th>Roll number</th><th>Source file</th>${headers}<th>Final marks</th><th>Paper total</th><th>Confidence</th><th>Recommendation</th></tr>${rows}</table></body></html>`;
}

async function handleEvaluate(req, res) {
  const body = await readBody(req);
  const { fields, files } = parseMultipart(body, req.headers['content-type']);
  const questionPaper = files.questionPaper;
  const answerKey = files.answerKey;
  const sheets = asArray(files.studentSheets);
  if (!questionPaper || !answerKey || !sheets.length) return json(res, 400, { error: 'Question paper, answer key, and at least one student sheet are required.' });
  const start = Math.max(1, Number(fields.rangeStart || 1));
  const end = Math.min(1000, Math.max(start, Number(fields.rangeEnd || sheets.length)));
  const required = Math.max(1, end - start + 1);
  if (sheets.length < required) return json(res, 400, { error: `The selected range ${start}–${end} requires ${required} uploaded student sheets, but only ${sheets.length} were provided.` });
  const selected = sheets.slice(0, required);
  if (!selected.length) return json(res, 400, { error: 'The selected student range does not contain uploaded sheets.' });
  try {
    const result = fillExactDocumentMatch(normalizePaper(await callModel(questionPaper, answerKey, selected)), answerKey, selected);
    const id = crypto.randomUUID();
    const evaluation = { id, createdAt: new Date().toISOString(), rangeStart: start, rangeEnd: end, ...result };
    evaluations.set(id, evaluation);
    await fs.mkdir(DATA, { recursive: true });
    await fs.writeFile(path.join(DATA, `${id}.json`), JSON.stringify(evaluation, null, 2));
    return json(res, 200, evaluation);
  } catch (error) { console.error('Evaluation failed:', error); return json(res, 502, { error: error.message }); }
}

async function handleApprove(req, res, id) {
  const evaluation = evaluations.get(id) || JSON.parse(await fs.readFile(path.join(DATA, `${id}.json`), 'utf8').catch(() => 'null'));
  if (!evaluation) return json(res, 404, { error: 'Evaluation not found.' });
  const approvedDir = path.join(DATA, 'approved'); await fs.mkdir(approvedDir, { recursive: true });
  const recordsPath = path.join(DATA, 'answer-key-records.json');
  const records = JSON.parse(await fs.readFile(recordsPath, 'utf8').catch(() => '[]'));
  const approvedAt = new Date().toISOString();
  const record = { ...evaluation, approvedAt, students: evaluation.students || [], questionMap: evaluation.questionMap || [] };
  const existingIndex = records.findIndex(item => item.id === evaluation.id);
  if (existingIndex >= 0) records[existingIndex] = record;
  else records.push(record);
  const fileName = 'answer-key-evaluation-records.xls';
  await fs.writeFile(recordsPath, JSON.stringify(records, null, 2));
  await fs.writeFile(path.join(approvedDir, fileName), cumulativeExcelHtml(records));
  evaluation.approvedAt = approvedAt; evaluation.excelFile = fileName; evaluations.set(id, evaluation);
  return json(res, 200, { approved: true, downloadUrl: '/api/download/records', fileName, recordCount: records.length });
}

async function handleRecords(req, res) {
  const recordsPath = path.join(DATA, 'answer-key-records.json');
  const loaded = JSON.parse(await fs.readFile(recordsPath, 'utf8').catch(() => '[]'));
  const normalized = normalizeSavedRecords(Array.isArray(loaded) ? loaded : []);
  const records = normalized.records;
  if (normalized.changed) {
    await fs.mkdir(path.join(DATA, 'approved'), { recursive: true });
    await fs.writeFile(recordsPath, JSON.stringify(records, null, 2));
    await fs.writeFile(path.join(DATA, 'approved', 'answer-key-evaluation-records.xls'), cumulativeExcelHtml(records));
  }
  return json(res, 200, { records });
}

async function serve(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'POST' && req.url === '/api/evaluate') return handleEvaluate(req, res);
  const approve = req.url?.match(/^\/api\/evaluations\/([^/]+)\/approve$/); if (req.method === 'POST' && approve) return handleApprove(req, res, approve[1]);
  if (req.method === 'GET' && req.url === '/api/records') return handleRecords(req, res);
  const download = req.url?.match(/^\/api\/download\/([^/]+)$/); if (req.method === 'GET' && download) { const file = download[1] === 'records' ? path.join(DATA, 'approved', 'answer-key-evaluation-records.xls') : path.join(DATA, 'approved', `answer-key-evaluation-${download[1]}.xls`); const content = await fs.readFile(file).catch(() => null); if (!content) return json(res, 404, { error: 'Approved file not found.' }); const fileName = download[1] === 'records' ? 'answer-key-evaluation-records.xls' : `answer-key-evaluation-${download[1]}.xls`; res.writeHead(200, { 'Content-Type': 'application/vnd.ms-excel', 'Content-Disposition': `attachment; filename="${fileName}"` }); return res.end(content); }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) { const content = await fs.readFile(HTML); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(content); }
  return json(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => serve(req, res).catch(error => json(res, 500, { error: error.message }))).listen(PORT, HOST, () => console.log(`Answer Key Studio backend running at http://localhost:${PORT}`));
