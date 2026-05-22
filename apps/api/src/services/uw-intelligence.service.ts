import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import {
  AssetType,
  HistoricalUnderwriting,
  HistoricalUWInputs,
  HistoricalUWAdjustments,
  HistoricalUWStructure,
  HistoricalUWSummary,
  BrokerNarrative,
  LearnedRule,
  PatternInsights,
  AdjustmentStats,
  AppliedIntelligence,
  DealOutcome,
  ConfidenceLevel,
  MarketIntelligence,
  BrokerSentiment,
  RentTrend,
  LoanType,
  PortfolioProperty,
  DataQuality,
  RuleVersion,
  RuleMetadata,
  DealOutcomeRow,
  DealOutcomeMatch,
  DealOutcomesUploadResult,
  OutcomeMatchConfidence,
  OutcomeReviewStatus,
  OutcomeAudit,
  UnmatchedOutcome,
} from '@cre/shared';
import { v4 as uuid } from 'uuid';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parsePdf } from './pdf-parser.service.js';

// ---------------------------------------------------------------------------
// Persistent JSON file storage
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve(process.cwd(), '.data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const UW_FILE = path.join(DATA_DIR, 'historical-uws.json');
const RULES_FILE = path.join(DATA_DIR, 'learned-rules.json');
const RULE_VERSIONS_FILE = path.join(DATA_DIR, 'rule-versions.json');
const RULE_METADATA_FILE = path.join(DATA_DIR, 'rule-metadata.json');
const UNMATCHED_OUTCOMES_FILE = path.join(DATA_DIR, 'unmatched-outcomes.json');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureUploadsDir(): void {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Original file storage — persist uploaded files to disk for later download
// ---------------------------------------------------------------------------

function saveUploadedFile(recordId: string, fileName: string, buffer: Buffer): void {
  ensureUploadsDir();
  const ext = path.extname(fileName).toLowerCase();
  const filePath = path.join(UPLOADS_DIR, `${recordId}${ext}`);
  fs.writeFileSync(filePath, buffer);
}

export function getUploadedFile(recordId: string): { buffer: Buffer; fileName: string; mimeType: string } | null {
  const uw = historicalUWs.get(recordId);
  if (!uw) return null;

  const ext = path.extname(uw.fileName).toLowerCase();
  const filePath = path.join(UPLOADS_DIR, `${recordId}${ext}`);
  if (!fs.existsSync(filePath)) return null;

  const mimeMap: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    '.csv': 'text/csv',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };

  return {
    buffer: fs.readFileSync(filePath),
    fileName: uw.fileName,
    mimeType: mimeMap[ext] || 'application/octet-stream',
  };
}

function deleteUploadedFile(recordId: string): void {
  // Try common extensions — we don't store the extension in the record
  for (const ext of ['.pdf', '.xlsx', '.xls', '.xlsm', '.csv', '.docx']) {
    const filePath = path.join(UPLOADS_DIR, `${recordId}${ext}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// PDF text extraction (delegates to existing pdf-parser service)
// ---------------------------------------------------------------------------

async function pdfToText(buffer: Buffer): Promise<string> {
  const result = await parsePdf(buffer);
  return result.rawText;
}

function isPdfFile(fileName: string): boolean {
  return path.extname(fileName).toLowerCase() === '.pdf';
}

function loadMap<T>(filePath: string): Map<string, T> {
  ensureDataDir();
  if (!fs.existsSync(filePath)) return new Map();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entries: [string, T][] = JSON.parse(raw);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function saveMap<T>(filePath: string, map: Map<string, T>): void {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify([...map.entries()], null, 2));
}

const historicalUWs = loadMap<HistoricalUnderwriting>(UW_FILE);
const learnedRules = loadMap<LearnedRule>(RULES_FILE);
const ruleVersions = loadMap<RuleVersion[]>(RULE_VERSIONS_FILE);
const unmatchedOutcomes = loadMap<UnmatchedOutcome>(UNMATCHED_OUTCOMES_FILE);

function persistUWs(): void { saveMap(UW_FILE, historicalUWs); }
function persistRules(): void { saveMap(RULES_FILE, learnedRules); }
function persistRuleVersions(): void { saveMap(RULE_VERSIONS_FILE, ruleVersions); }
function persistUnmatchedOutcomes(): void { saveMap(UNMATCHED_OUTCOMES_FILE, unmatchedOutcomes); }

// Rule metadata — tracks recalculation state
function loadRuleMetadata(): RuleMetadata {
  ensureDataDir();
  if (!fs.existsSync(RULE_METADATA_FILE)) {
    return { lastUpdated: null, totalDeals: 0, rejected: 0, approved: 0, modified: 0, ruleCount: 0, ruleVersion: 0 };
  }
  try {
    return JSON.parse(fs.readFileSync(RULE_METADATA_FILE, 'utf-8'));
  } catch {
    return { lastUpdated: null, totalDeals: 0, rejected: 0, approved: 0, modified: 0, ruleCount: 0, ruleVersion: 0 };
  }
}

function persistRuleMetadata(meta: RuleMetadata): void {
  ensureDataDir();
  fs.writeFileSync(RULE_METADATA_FILE, JSON.stringify(meta, null, 2));
}

let ruleMetadata = loadRuleMetadata();

export function getRuleMetadata(): RuleMetadata {
  return ruleMetadata;
}

// ---------------------------------------------------------------------------
// DATA MIGRATION — add new fields to existing records
// ---------------------------------------------------------------------------

let _migrated = false;
for (const [id, uw] of historicalUWs) {
  if (!('loanType' in uw)) {
    (uw as any).loanType = 'single_asset';
    (uw as any).parentId = null;
    (uw as any).portfolioProperties = [];
    (uw as any).fileHash = '';
    (uw as any).dataQuality = 'complete';
    _migrated = true;
  }
  if (!('outcomeSource' in uw)) {
    (uw as any).outcomeSource = null;
    (uw as any).outcomeConfidence = null;
    (uw as any).kickMatchId = null;
    (uw as any).outcomeAudit = null;
    _migrated = true;
  }
}
for (const [id, rule] of learnedRules) {
  if (!('version' in rule)) {
    (rule as any).version = 1;
    _migrated = true;
  }
  if (!('metric' in rule)) {
    (rule as any).metric = null;
    (rule as any).threshold = null;
    (rule as any).pctDealsAffected = null;
    (rule as any).pctDealsRejected = null;
    _migrated = true;
  }
}
if (_migrated) {
  persistUWs();
  persistRules();
}

console.log(`[UW Intelligence] Loaded ${historicalUWs.size} historical UWs, ${learnedRules.size} learned rules from disk.`);

// ---------------------------------------------------------------------------
// DUPLICATE DETECTION
// ---------------------------------------------------------------------------

export function computeFileHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizedSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;
  const longer = s1.length >= s2.length ? s1 : s2;
  const shorter = s1.length >= s2.length ? s2 : s1;
  const dist = levenshteinDistance(longer, shorter);
  return (longer.length - dist) / longer.length;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function findDuplicates(
  dealName: string,
  loanAmount: number | null,
  fileHash: string
): { exact: HistoricalUnderwriting | null; probable: HistoricalUnderwriting[] } {
  let exact: HistoricalUnderwriting | null = null;
  const probable: HistoricalUnderwriting[] = [];

  for (const uw of historicalUWs.values()) {
    // Exact duplicate — file content hash match
    if (fileHash && uw.fileHash && uw.fileHash === fileHash) {
      exact = uw;
      return { exact, probable: [] };
    }

    // Probable duplicate — name similarity + loan amount proximity
    // Require a financial signal to confirm; name alone is not enough because
    // CRE deals often share similar names (property type + location patterns).
    const nameSim = normalizedSimilarity(dealName, uw.dealName);
    if (nameSim > 0.85 && loanAmount && uw.inputs.loanAmount) {
      const diff = Math.abs(loanAmount - uw.inputs.loanAmount) / Math.max(loanAmount, uw.inputs.loanAmount);
      if (diff < 0.02) {
        probable.push(uw);
      }
    }
  }

  return { exact, probable };
}

// ---------------------------------------------------------------------------
// DATA QUALITY ASSESSMENT
// ---------------------------------------------------------------------------

function assessDataQuality(inputs: HistoricalUWInputs): DataQuality {
  const keyFields = [inputs.noi, inputs.loanAmount, inputs.ltv, inputs.dscr, inputs.capRate];
  const missing = keyFields.filter(v => v === null || v === undefined).length;
  if (missing === 0) return 'complete';
  if (missing <= 2) return 'partial';
  return 'incomplete';
}

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

function extractJSON(text: string): any {
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  // find first { to last }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    const candidate = cleaned.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. INGESTION — Parse uploaded file and create HistoricalUnderwriting
// ---------------------------------------------------------------------------

export async function ingestUnderwriting(
  buffer: Buffer,
  fileName: string,
  assetType: AssetType,
  outcome: DealOutcome,
  dealName: string,
  date: string,
  notes: string
): Promise<HistoricalUnderwriting & { _skipped?: boolean; _skipReason?: string }> {
  // Compute file hash for duplicate detection
  const fileHash = computeFileHash(buffer);

  // Parse file to text (PDF or Excel)
  const rawText = isPdfFile(fileName) ? await pdfToText(buffer) : excelToText(buffer);

  // Use AI to extract structured underwriting data
  const extracted = await extractUWDataFromText(rawText, assetType);

  // Check for duplicates
  const loanAmount = extracted.inputs?.loanAmount ?? null;
  const dupes = findDuplicates(dealName, loanAmount, fileHash);
  if (dupes.exact) {
    return { ...dupes.exact, _skipped: true, _skipReason: 'Exact duplicate (file hash match)' };
  }
  if (dupes.probable.length > 0) {
    return { ...dupes.probable[0], _skipped: true, _skipReason: `Probable duplicate of "${dupes.probable[0].dealName}"` };
  }

  const dateYear = date ? parseInt(date.split('-')[0], 10) : new Date().getFullYear();
  const resolvedYear = extracted.broker.year || dateYear;
  const dataQuality = assessDataQuality(extracted.inputs);

  const now = new Date().toISOString();
  const recordId = uuid();

  // Save original file to disk for later download
  saveUploadedFile(recordId, fileName, buffer);

  const record: HistoricalUnderwriting = {
    id: recordId,
    assetType,
    dealName,
    outcome,
    date,
    year: resolvedYear,
    notes,
    fileName,
    fileSize: buffer.length,
    brokerName: extracted.broker.brokerName,
    brokerFirm: extracted.broker.brokerFirm,
    city: extracted.broker.city,
    state: extracted.broker.state,
    brokerNarratives: extracted.brokerNarratives,
    inputs: extracted.inputs,
    adjustments: extracted.adjustments,
    structure: extracted.structure,
    loanType: 'single_asset',
    parentId: null,
    portfolioProperties: [],
    fileHash,
    dataQuality,
    outcomeSource: null,
    outcomeConfidence: null,
    kickMatchId: null,
    outcomeAudit: null,
    extractedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  historicalUWs.set(record.id, record);
  persistUWs();

  // Auto-update rules in background after new data ingestion
  triggerBackgroundRuleUpdate([assetType]);

  return record;
}

function excelToText(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  let text = '';
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as string[][];
    const sheetText = data.map((row) => row.join('\t')).join('\n');
    text += `\n--- ${sheetName} ---\n${sheetText}\n`;
  }
  return text;
}

async function extractUWDataFromText(
  rawText: string,
  assetType: AssetType
): Promise<{
  inputs: HistoricalUWInputs;
  adjustments: HistoricalUWAdjustments;
  structure: HistoricalUWStructure;
  broker: { brokerName: string; brokerFirm: string; city: string; state: string; year: number | null };
  brokerNarratives: BrokerNarrative[];
}> {
  const ai = getClient();
  const truncated = rawText.slice(0, 50000);

  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 6000,
    system: `You are an expert CRE underwriting analyst. Extract structured data AND market-level commentary from underwriting files.
Return ONLY valid JSON with no other text. Extract commentary EXACTLY as written — do NOT invent or paraphrase.

CRITICAL DISTINCTION — MARKET vs PROPERTY:
Your "brokerNarratives" output must contain ONLY market-level and sub-market-level intelligence.
DO NOT include property-specific information such as:
- The subject property's NOI, occupancy, rent roll, or financials
- The property's physical description, unit count, square footage, or condition
- The deal structure, loan terms, or borrower/sponsor details
- The property's specific tenants, lease terms, or tenant credit
- The property's valuation, appraisal, or cap rate
ONLY include commentary about the broader MARKET and SUB-MARKET:
- Market vacancy rates, absorption, rent trends for the area (not this property)
- Supply pipeline / new construction in the submarket
- Demand drivers, employment growth, population trends
- Broker opinions on market direction and outlook
- Comparable transactions as market data points (not as property valuations)
- Regulatory or zoning changes affecting the market
- Economic or demographic trends in the metro/submarket`,
    messages: [
      {
        role: 'user',
        content: `Extract the following from this ${assetType} underwriting spreadsheet data.
Return null for any field you cannot find. If a value is uncertain, use "Unknown / Needs Review" for strings and null for numbers.

CRITICAL — EXTRACT MARKET & SUB-MARKET COMMENTARY ONLY:
CRE underwriting files contain market intelligence in many places. You MUST find and extract ALL market-level commentary.

IMPORTANT: Do NOT extract property-specific information into brokerNarratives. Only extract commentary
about the BROADER MARKET or SUB-MARKET — not about the subject property itself.

YES — extract these (market-level):
- Market-wide vacancy rates, absorption trends, and rent growth for the MSA or submarket
- New construction pipeline and deliveries in the submarket (not renovations to this property)
- Broker opinions on market direction, outlook, and investment sentiment
- Employment growth, population migration, economic drivers for the area
- Supply/demand dynamics for the asset class in this market
- Comparable market rents, market cap rates, and transaction volume
- Regulatory or zoning changes affecting the broader market
- Submarket descriptions and competitive positioning (e.g. "Midtown Atlanta office submarket")

NO — do NOT extract these (property-specific):
- This property's NOI, occupancy, rent roll, or unit-level financials
- This property's physical description, condition, or renovation plans
- This deal's loan terms, structure, or borrower details
- This property's specific tenants or lease expirations
- This property's appraisal or valuation conclusions

Look in Market Analysis sheets, Executive Summary market context paragraphs, Risk sections
with market warnings, and Appraisal sections with market rent comparisons.

Create MULTIPLE narrative entries — one per distinct market topic found. For example:
- One for submarket vacancy/absorption trends
- One for new supply pipeline in the area
- One for rent growth trends in the market
- One for broker sentiment / investment outlook
- One for economic or demographic drivers

For each narrative, the "excerpt" field must contain the EXACT verbatim text from the source.
The "marketNarrative" field should be a clean summary of the MARKET-level finding (not property-level).
The "subMarketNarrative" should capture sub-market specifics if present.

Return JSON in this exact shape:
{
  "inputs": {
    "noi": <number or null>,
    "rents": <number or null>,
    "vacancy": <number or null — as decimal>,
    "expenses": <number or null>,
    "capRate": <number or null — as decimal>,
    "loanAmount": <number or null>,
    "loanTerm": <number or null — in years>,
    "interestRate": <number or null — as decimal>,
    "ltv": <number or null — as decimal>,
    "dscr": <number or null>
  },
  "adjustments": {
    "noiAdjustment": <% change from reported NOI or null>,
    "capRateAdjustment": <bps added to reported cap rate or null>,
    "valueAdjustment": <% change from reported/appraised value or null>,
    "leverageAdjustment": <% change from requested LTV or null>
  },
  "structure": {
    "reserves": <dollar amount of reserves or null>,
    "recourse": <true/false or null>,
    "cashManagement": <true/false or null>,
    "earnOut": <true/false or null>
  },
  "broker": {
    "brokerName": <string or "Unknown / Needs Review">,
    "brokerFirm": <string or "Unknown / Needs Review">,
    "city": <string or "Unknown / Needs Review">,
    "state": <string — 2-letter code or "Unknown / Needs Review">,
    "year": <number or null>
  },
  "brokerNarratives": [
    {
      "subMarket": <string — sub-market area e.g. "Midtown Atlanta" or "Unknown / Needs Review">,
      "marketNarrative": <string — summarized market finding>,
      "subMarketNarrative": <string — sub-market specific detail>,
      "excerpt": <string — EXACT verbatim text copied from the source>,
      "sourcePage": <string — sheet name where found, e.g. "Market and Sponsor">,
      "sourceSection": <string — section heading, e.g. "MARKET ANALYSIS" or "CONCERNS">,
      "confidence": <"high" | "medium" | "low">
    }
  ]
}

You MUST return at least one brokerNarrative entry if ANY market-related text exists in the file.
Return "brokerNarratives": [] ONLY if the file contains zero market commentary whatsoever.

Spreadsheet data:
${truncated}`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const parsed = extractJSON(text);

  const defaultBroker = { brokerName: 'Unknown / Needs Review', brokerFirm: 'Unknown / Needs Review', city: 'Unknown / Needs Review', state: 'Unknown / Needs Review', year: null };

  if (!parsed) {
    return {
      inputs: { noi: null, rents: null, vacancy: null, expenses: null, capRate: null, loanAmount: null, loanTerm: null, interestRate: null, ltv: null, dscr: null },
      adjustments: { noiAdjustment: null, capRateAdjustment: null, valueAdjustment: null, leverageAdjustment: null },
      structure: { reserves: null, recourse: null, cashManagement: null, earnOut: null },
      broker: defaultBroker,
      brokerNarratives: [],
    };
  }

  const narratives: BrokerNarrative[] = (parsed.brokerNarratives || []).map((n: any) => ({
    brokerName: parsed.broker?.brokerName || defaultBroker.brokerName,
    brokerFirm: parsed.broker?.brokerFirm || defaultBroker.brokerFirm,
    subMarket: n.subMarket || 'Unknown / Needs Review',
    marketNarrative: n.marketNarrative || '',
    subMarketNarrative: n.subMarketNarrative || '',
    excerpt: n.excerpt || '',
    sourcePage: n.sourcePage || 'Unknown',
    sourceSection: n.sourceSection || 'Unknown',
    confidence: (['high', 'medium', 'low'].includes(n.confidence) ? n.confidence : 'low') as ConfidenceLevel,
  }));

  return {
    inputs: { ...{ noi: null, rents: null, vacancy: null, expenses: null, capRate: null, loanAmount: null, loanTerm: null, interestRate: null, ltv: null, dscr: null }, ...parsed.inputs },
    adjustments: { ...{ noiAdjustment: null, capRateAdjustment: null, valueAdjustment: null, leverageAdjustment: null }, ...parsed.adjustments },
    structure: { ...{ reserves: null, recourse: null, cashManagement: null, earnOut: null }, ...parsed.structure },
    broker: { ...defaultBroker, ...parsed.broker },
    brokerNarratives: narratives,
  };
}

// ---------------------------------------------------------------------------
// 1b. BATCH INGESTION — Auto-classify from file content alone
// ---------------------------------------------------------------------------

const VALID_ASSET_TYPES: AssetType[] = ['office', 'multifamily', 'retail', 'industrial', 'hotel', 'self_storage', 'mixed_use', 'manufactured_housing'];
const VALID_OUTCOMES: DealOutcome[] = ['approved', 'modified', 'rejected'];

export async function ingestAutoClassified(
  buffer: Buffer,
  fileName: string
): Promise<HistoricalUnderwriting & { _skipped?: boolean; _skipReason?: string }> {
  // Compute file hash for duplicate detection (before expensive AI call)
  const fileHash = computeFileHash(buffer);

  // Quick hash-based dedup check before parsing
  for (const uw of historicalUWs.values()) {
    if (fileHash && uw.fileHash && uw.fileHash === fileHash) {
      return { ...uw, _skipped: true, _skipReason: 'Exact duplicate (file hash match)' };
    }
  }

  const rawText = isPdfFile(fileName) ? await pdfToText(buffer) : excelToText(buffer);
  const ai = getClient();
  const truncated = rawText.slice(0, 50000);

  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 6000,
    system: `You are an expert CRE underwriting analyst. Extract ALL structured data AND market-level commentary from underwriting files.
You must determine the asset class, deal name, outcome, and all financial data from the file content.
Extract commentary EXACTLY as written — do NOT invent or paraphrase.
Return ONLY valid JSON with no other text.

CRITICAL DISTINCTION — MARKET vs PROPERTY:
Your "brokerNarratives" output must contain ONLY market-level and sub-market-level intelligence.
DO NOT include property-specific information such as:
- The subject property's NOI, occupancy, rent roll, or financials
- The property's physical description, unit count, square footage, or condition
- The deal structure, loan terms, or borrower/sponsor details
- The property's specific tenants, lease terms, or tenant credit
- The property's valuation, appraisal, or cap rate
ONLY include commentary about the broader MARKET and SUB-MARKET:
- Market vacancy rates, absorption, rent trends for the area (not this property)
- Supply pipeline / new construction in the submarket
- Demand drivers, employment growth, population trends
- Broker opinions on market direction and outlook
- Comparable transactions as market data points (not as property valuations)
- Regulatory or zoning changes affecting the market
- Economic or demographic trends in the metro/submarket`,
    messages: [
      {
        role: 'user',
        content: `Analyze this underwriting spreadsheet and extract EVERYTHING. You must classify the deal yourself.
If a value is uncertain, use "Unknown / Needs Review" for strings and null for numbers. Do NOT guess silently.

CRITICAL — EXTRACT MARKET & SUB-MARKET COMMENTARY ONLY:
CRE underwriting files contain market intelligence in many places. You MUST find and extract ALL market-level commentary.

IMPORTANT: Do NOT extract property-specific information into brokerNarratives. Only extract commentary
about the BROADER MARKET or SUB-MARKET — not about the subject property itself.

YES — extract these (market-level):
- Market-wide vacancy rates, absorption trends, and rent growth for the MSA or submarket
- New construction pipeline and deliveries in the submarket (not renovations to this property)
- Broker opinions on market direction, outlook, and investment sentiment
- Employment growth, population migration, economic drivers for the area
- Supply/demand dynamics for the asset class in this market
- Comparable market rents, market cap rates, and transaction volume
- Regulatory or zoning changes affecting the broader market
- Submarket descriptions and competitive positioning

NO — do NOT extract these (property-specific):
- This property's NOI, occupancy, rent roll, or unit-level financials
- This property's physical description, condition, or renovation plans
- This deal's loan terms, structure, or borrower details
- This property's specific tenants or lease expirations
- This property's appraisal or valuation conclusions

Look in Market Analysis sheets, Executive Summary market context paragraphs, Risk sections
with market warnings, and Appraisal sections with market rent comparisons.

Create MULTIPLE narrative entries — one per distinct market topic found.

For each narrative, the "excerpt" field must contain the EXACT verbatim text from the source.
The "marketNarrative" must be a MARKET-level summary, NOT a property-level one.

Return JSON in this exact shape:
{
  "classification": {
    "assetType": <one of: office, multifamily, retail, industrial, hotel, self_storage, mixed_use, manufactured_housing>,
    "dealName": <string — property/deal name from the file>,
    "outcome": <one of: approved, modified, rejected — determine from the file content, or "approved" if unclear>,
    "year": <number — year of the loan/deal>,
    "date": <string — ISO date if found, or null>
  },
  "loanClassification": {
    "loanType": <"single_asset" if one property, "portfolio" if multiple distinct properties financed together>,
    "portfolioProperties": [
      {
        "name": <string — individual property name>,
        "city": <string — property city>,
        "state": <string — 2-letter state code>,
        "assetClass": <one of: office, multifamily, retail, industrial, hotel, self_storage, mixed_use, manufactured_housing>,
        "units": <number or null — unit count for multifamily/hotel/storage>,
        "sf": <number or null — square footage for office/retail/industrial>
      }
    ]
  },
  "broker": {
    "brokerName": <string or "Unknown / Needs Review">,
    "brokerFirm": <string or "Unknown / Needs Review">,
    "city": <string or "Unknown / Needs Review">,
    "state": <string — 2-letter US state code or "Unknown / Needs Review">
  },
  "inputs": {
    "noi": <number or null>,
    "rents": <number or null>,
    "vacancy": <number or null — as decimal>,
    "expenses": <number or null>,
    "capRate": <number or null — as decimal>,
    "loanAmount": <number or null>,
    "loanTerm": <number or null — in years>,
    "interestRate": <number or null — as decimal>,
    "ltv": <number or null — as decimal>,
    "dscr": <number or null>
  },
  "adjustments": {
    "noiAdjustment": <% change or null>,
    "capRateAdjustment": <bps or null>,
    "valueAdjustment": <% change or null>,
    "leverageAdjustment": <% change or null>
  },
  "structure": {
    "reserves": <dollar amount or null>,
    "recourse": <true/false or null>,
    "cashManagement": <true/false or null>,
    "earnOut": <true/false or null>
  },
  "brokerNarratives": [
    {
      "subMarket": <string — sub-market area e.g. "Midtown Atlanta" or "Unknown / Needs Review">,
      "marketNarrative": <string — summarized market finding>,
      "subMarketNarrative": <string — sub-market specific detail>,
      "excerpt": <string — EXACT verbatim text copied from the source>,
      "sourcePage": <string — sheet name where found>,
      "sourceSection": <string — section heading e.g. "MARKET ANALYSIS" or "CONCERNS">,
      "confidence": <"high" | "medium" | "low">
    }
  ]
}

You MUST return at least one brokerNarrative entry if ANY market-related text exists in the file.
Return "brokerNarratives": [] ONLY if the file contains zero market commentary whatsoever.

Spreadsheet data:
${truncated}`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const parsed = extractJSON(text);

  const defaultClassification = {
    assetType: 'office' as AssetType,
    dealName: fileName.replace(/\.(xlsx?|xls|xlsm|pdf)$/i, ''),
    outcome: 'approved' as DealOutcome,
    year: new Date().getFullYear(),
    date: new Date().toISOString().split('T')[0],
  };
  const defaultBroker = { brokerName: 'Unknown / Needs Review', brokerFirm: 'Unknown / Needs Review', city: 'Unknown / Needs Review', state: 'Unknown / Needs Review' };
  const defaultInputs = { noi: null, rents: null, vacancy: null, expenses: null, capRate: null, loanAmount: null, loanTerm: null, interestRate: null, ltv: null, dscr: null };
  const defaultAdjustments = { noiAdjustment: null, capRateAdjustment: null, valueAdjustment: null, leverageAdjustment: null };
  const defaultStructure = { reserves: null, recourse: null, cashManagement: null, earnOut: null };

  const classification = parsed?.classification ? { ...defaultClassification, ...parsed.classification } : defaultClassification;
  const broker = parsed?.broker ? { ...defaultBroker, ...parsed.broker } : defaultBroker;

  // Validate asset type and outcome
  if (!VALID_ASSET_TYPES.includes(classification.assetType)) classification.assetType = 'office';
  if (!VALID_OUTCOMES.includes(classification.outcome)) classification.outcome = 'approved';

  const narratives: BrokerNarrative[] = (parsed?.brokerNarratives || []).map((n: any) => ({
    brokerName: broker.brokerName,
    brokerFirm: broker.brokerFirm,
    subMarket: n.subMarket || 'Unknown / Needs Review',
    marketNarrative: n.marketNarrative || '',
    subMarketNarrative: n.subMarketNarrative || '',
    excerpt: n.excerpt || '',
    sourcePage: n.sourcePage || 'Unknown',
    sourceSection: n.sourceSection || 'Unknown',
    confidence: (['high', 'medium', 'low'].includes(n.confidence) ? n.confidence : 'low') as ConfidenceLevel,
  }));

  // Extract loan classification
  const loanClassification = parsed?.loanClassification || { loanType: 'single_asset', portfolioProperties: [] };
  const loanType: LoanType = loanClassification.loanType === 'portfolio' ? 'portfolio' : 'single_asset';
  const portfolioProperties: PortfolioProperty[] = (loanClassification.portfolioProperties || []).map((p: any) => ({
    name: p.name || 'Unknown',
    city: p.city || 'Unknown',
    state: p.state || 'Unknown',
    assetClass: VALID_ASSET_TYPES.includes(p.assetClass) ? p.assetClass : classification.assetType,
    units: typeof p.units === 'number' ? p.units : null,
    sf: typeof p.sf === 'number' ? p.sf : null,
  }));

  const resolvedDealName = classification.dealName || fileName;
  const inputs = parsed?.inputs ? { ...defaultInputs, ...parsed.inputs } : defaultInputs;
  const dataQuality = assessDataQuality(inputs);

  // Check for probable duplicates (hash already checked above)
  const dupes = findDuplicates(resolvedDealName, inputs.loanAmount, fileHash);
  if (dupes.probable.length > 0) {
    return { ...dupes.probable[0], _skipped: true, _skipReason: `Probable duplicate of "${dupes.probable[0].dealName}"` };
  }

  const now = new Date().toISOString();
  const recordId = uuid();

  // Save original file to disk for later download
  saveUploadedFile(recordId, fileName, buffer);

  const record: HistoricalUnderwriting = {
    id: recordId,
    assetType: classification.assetType,
    dealName: resolvedDealName,
    outcome: classification.outcome,
    date: classification.date || now.split('T')[0],
    year: classification.year || new Date().getFullYear(),
    notes: '',
    fileName,
    fileSize: buffer.length,
    brokerName: broker.brokerName,
    brokerFirm: broker.brokerFirm,
    city: broker.city,
    state: broker.state,
    brokerNarratives: narratives,
    inputs,
    adjustments: parsed?.adjustments ? { ...defaultAdjustments, ...parsed.adjustments } : defaultAdjustments,
    structure: parsed?.structure ? { ...defaultStructure, ...parsed.structure } : defaultStructure,
    loanType,
    parentId: null,
    portfolioProperties,
    fileHash,
    dataQuality,
    outcomeSource: null,
    outcomeConfidence: null,
    kickMatchId: null,
    outcomeAudit: null,
    extractedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  historicalUWs.set(record.id, record);

  // Create child records for portfolio properties
  if (loanType === 'portfolio' && portfolioProperties.length > 1) {
    for (const prop of portfolioProperties) {
      const childRecord: HistoricalUnderwriting = {
        id: uuid(),
        assetType: prop.assetClass,
        dealName: prop.name,
        outcome: classification.outcome,
        date: classification.date || now.split('T')[0],
        year: classification.year || new Date().getFullYear(),
        notes: `Part of portfolio: ${resolvedDealName}`,
        fileName,
        fileSize: 0,
        brokerName: broker.brokerName,
        brokerFirm: broker.brokerFirm,
        city: prop.city,
        state: prop.state,
        brokerNarratives: [],
        inputs: defaultInputs,
        adjustments: defaultAdjustments,
        structure: defaultStructure,
        loanType: 'single_asset',
        parentId: record.id,
        portfolioProperties: [],
        fileHash: '',
        dataQuality: 'partial',
        outcomeSource: null,
        outcomeConfidence: null,
        kickMatchId: null,
        outcomeAudit: null,
        extractedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      historicalUWs.set(childRecord.id, childRecord);
    }
  }

  persistUWs();

  // Auto-update rules in background after new data ingestion
  triggerBackgroundRuleUpdate([classification.assetType]);

  return record;
}

// ---------------------------------------------------------------------------
// BACKGROUND RULE UPDATE — fires asynchronously after data changes
// ---------------------------------------------------------------------------

let _pendingRuleUpdate: NodeJS.Timeout | null = null;
const _pendingAssetTypes = new Set<AssetType>();

/**
 * Debounced background rule update. Collects asset types and fires
 * a single update after a short delay (to batch rapid successive uploads).
 */
function triggerBackgroundRuleUpdate(assetTypes: AssetType[]): void {
  for (const at of assetTypes) _pendingAssetTypes.add(at);

  if (_pendingRuleUpdate) clearTimeout(_pendingRuleUpdate);
  _pendingRuleUpdate = setTimeout(() => {
    const types = [..._pendingAssetTypes];
    _pendingAssetTypes.clear();
    _pendingRuleUpdate = null;

    const result = postIngestionIntelligenceUpdate(types);
    console.log(`[UW Intelligence] Background rule update: updated=[${result.updated.join(',')}] skipped=[${result.skipped.join(',')}]`);
  }, 2000); // 2-second debounce to batch rapid uploads
}

// ---------------------------------------------------------------------------
// 2. CRUD operations
// ---------------------------------------------------------------------------

export function getHistoricalUW(id: string): HistoricalUnderwriting | null {
  return historicalUWs.get(id) || null;
}

export function listHistoricalUWs(): HistoricalUWSummary[] {
  return Array.from(historicalUWs.values()).map((uw) => ({
    id: uw.id,
    assetType: uw.assetType,
    dealName: uw.dealName,
    outcome: uw.outcome,
    date: uw.date,
    year: uw.year,
    fileName: uw.fileName,
    brokerName: uw.brokerName,
    brokerFirm: uw.brokerFirm,
    city: uw.city,
    state: uw.state,
    notes: uw.notes,
    loanType: uw.loanType || 'single_asset',
    parentId: uw.parentId || null,
    portfolioProperties: uw.portfolioProperties || [],
    brokerNarratives: uw.brokerNarratives || [],
    createdAt: uw.createdAt,
  }));
}

/**
 * Returns the full HistoricalUnderwriting records (not summaries) for batch
 * processing. Used by the issue #20 connector (`import-historical-uws-to-approved`)
 * which needs the complete `inputs` block + per-deal metadata to project into
 * ApprovedDeal shape. NOT for general consumer use — the summary form
 * (`listHistoricalUWs`) is the preferred public read.
 */
export function listHistoricalUWsFull(): readonly HistoricalUnderwriting[] {
  return Array.from(historicalUWs.values());
}

export function getPortfolioChildren(parentId: string): HistoricalUnderwriting[] {
  return Array.from(historicalUWs.values()).filter(uw => uw.parentId === parentId);
}

export function updateHistoricalUW(
  id: string,
  updates: Partial<Pick<HistoricalUnderwriting, 'assetType' | 'dealName' | 'outcome' | 'year' | 'notes' | 'brokerName' | 'brokerFirm' | 'city' | 'state'>>
): HistoricalUnderwriting | null {
  const existing = historicalUWs.get(id);
  if (!existing) return null;
  const updated: HistoricalUnderwriting = {
    ...existing,
    ...updates,
    id,
    updatedAt: new Date().toISOString(),
  };
  historicalUWs.set(id, updated);
  persistUWs();
  return updated;
}

export function deleteHistoricalUW(id: string): boolean {
  const result = historicalUWs.delete(id);
  if (result) {
    persistUWs();
    deleteUploadedFile(id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Re-extract broker narratives for all historical UWs using updated prompts
// ---------------------------------------------------------------------------

export async function reExtractAllNarratives(): Promise<{ total: number; updated: number; errors: string[] }> {
  const ai = getClient();
  const all = Array.from(historicalUWs.values());
  let updated = 0;
  const errors: string[] = [];

  for (const uw of all) {
    if (!uw.brokerNarratives || uw.brokerNarratives.length === 0) continue;

    // Build context from existing excerpts — this is the raw source text we have
    const excerptContext = uw.brokerNarratives
      .map((n, i) => `--- Excerpt ${i + 1} (from ${n.sourceSection || 'Unknown section'}, ${n.sourcePage || 'Unknown page'}) ---\n${n.excerpt}`)
      .join('\n\n');

    if (!excerptContext.trim()) continue;

    try {
      const response = await ai.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: `You are an expert CRE underwriting analyst. Your job is to filter and rewrite broker narratives to contain ONLY market-level and sub-market-level intelligence.

CRITICAL DISTINCTION:
- KEEP: Market vacancy rates, absorption, rent trends, supply pipeline, new construction, employment growth, population trends, broker outlook, demand drivers, market cap rates, transaction volume, regulatory changes, submarket descriptions
- REMOVE: Property-specific info — the subject property's NOI, occupancy, rent roll, tenants, lease terms, physical description, unit count, square footage, condition, renovation plans, deal/loan terms, borrower/sponsor details, appraisal/valuation

Return ONLY valid JSON. If an excerpt contains NO market-level information at all, skip it entirely.`,
        messages: [{
          role: 'user',
          content: `Below are excerpts from a ${uw.assetType} underwriting file for a property in ${uw.city}, ${uw.state}.

Re-extract ONLY the market-level and sub-market-level intelligence from these excerpts. Remove anything about the subject property itself.

${excerptContext}

Return JSON array:
[
  {
    "subMarket": <string — sub-market area or "Unknown / Needs Review">,
    "marketNarrative": <string — clean MARKET-level summary, NOT about the property>,
    "subMarketNarrative": <string — sub-market specific detail>,
    "excerpt": <string — the relevant portion of the original excerpt that is market-level>,
    "sourcePage": <string — preserved from original>,
    "sourceSection": <string — preserved from original>,
    "confidence": <"high" | "medium" | "low">
  }
]

Return [] if none of the excerpts contain genuine market-level intelligence.`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const parsed = extractJSON(text);

      if (Array.isArray(parsed)) {
        const newNarratives: BrokerNarrative[] = parsed.map((n: any) => ({
          brokerName: uw.brokerName,
          brokerFirm: uw.brokerFirm,
          subMarket: n.subMarket || 'Unknown / Needs Review',
          marketNarrative: n.marketNarrative || '',
          subMarketNarrative: n.subMarketNarrative || '',
          excerpt: n.excerpt || '',
          sourcePage: n.sourcePage || 'Unknown',
          sourceSection: n.sourceSection || 'Unknown',
          confidence: (['high', 'medium', 'low'].includes(n.confidence) ? n.confidence : 'low') as ConfidenceLevel,
        }));

        uw.brokerNarratives = newNarratives;
        uw.updatedAt = new Date().toISOString();
        historicalUWs.set(uw.id, uw);
        updated++;
      }
    } catch (err: any) {
      errors.push(`${uw.dealName}: ${err.message}`);
    }
  }

  persistUWs();
  return { total: all.length, updated, errors };
}

export function getLearnedRule(id: string): LearnedRule | null {
  return learnedRules.get(id) || null;
}

export function listLearnedRules(assetType?: AssetType): LearnedRule[] {
  const all = Array.from(learnedRules.values());
  if (!assetType) return all;
  return all.filter((r) => r.assetType === assetType || r.assetType === 'all');
}

export function updateLearnedRule(id: string, updates: Partial<LearnedRule>): LearnedRule | null {
  const existing = learnedRules.get(id);
  if (!existing) return null;

  // Archive current version before updating (if rule text or status changes)
  if (updates.rule || updates.status || updates.confidenceLevel) {
    archiveRuleVersion(existing, 'manual update');
  }

  const newVersion = (existing.version || 1) + (updates.rule ? 1 : 0);
  const updated = { ...existing, ...updates, id, version: newVersion, updatedAt: new Date().toISOString() };
  learnedRules.set(id, updated);
  persistRules();
  return updated;
}

export function deleteLearnedRule(id: string): boolean {
  const result = learnedRules.delete(id);
  if (result) persistRules();
  return result;
}

// ---------------------------------------------------------------------------
// RULE VERSIONING
// ---------------------------------------------------------------------------

function archiveRuleVersion(rule: LearnedRule, reason: string): void {
  const versions = ruleVersions.get(rule.id) || [];
  versions.push({
    ruleId: rule.id,
    version: rule.version || 1,
    rule: rule.rule,
    confidenceLevel: rule.confidenceLevel,
    sampleSize: rule.sampleSize,
    supportingDealIds: rule.supportingDealIds,
    createdAt: new Date().toISOString(),
    reason,
  });
  ruleVersions.set(rule.id, versions);
  persistRuleVersions();
}

export function getRuleVersions(ruleId: string): RuleVersion[] {
  return ruleVersions.get(ruleId) || [];
}

export function rollbackRule(ruleId: string, targetVersion: number): LearnedRule | null {
  const versions = ruleVersions.get(ruleId) || [];
  const target = versions.find(v => v.version === targetVersion);
  if (!target) return null;

  const existing = learnedRules.get(ruleId);
  if (!existing) return null;

  // Archive current state before rollback
  archiveRuleVersion(existing, 'rollback');

  const rolledBack: LearnedRule = {
    ...existing,
    rule: target.rule,
    confidenceLevel: target.confidenceLevel,
    sampleSize: target.sampleSize,
    supportingDealIds: target.supportingDealIds,
    version: (existing.version || 1) + 1,
    updatedAt: new Date().toISOString(),
  };

  learnedRules.set(ruleId, rolledBack);
  persistRules();
  return rolledBack;
}

// ---------------------------------------------------------------------------
// 3. PATTERN EXTRACTION — Compute aggregate statistics
// ---------------------------------------------------------------------------

function computeStats(values: number[]): AdjustmentStats | null {
  if (values.length < 3) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  return {
    mean: round(mean),
    median: round(median),
    min: round(sorted[0]),
    max: round(sorted[n - 1]),
    stdDev: round(stdDev),
    sampleSize: n,
  };
}

function round(v: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(v * factor) / factor;
}

export function computePatternInsights(assetType?: AssetType): PatternInsights {
  const deals = assetType
    ? Array.from(historicalUWs.values()).filter((uw) => uw.assetType === assetType)
    : Array.from(historicalUWs.values());

  const outcomeBreakdown = { approved: 0, modified: 0, rejected: 0 };
  for (const d of deals) outcomeBreakdown[d.outcome]++;

  const noiAdjs = deals.map((d) => d.adjustments.noiAdjustment).filter((v): v is number => v !== null);
  const capRateAdjs = deals.map((d) => d.adjustments.capRateAdjustment).filter((v): v is number => v !== null);
  const ltvs = deals.map((d) => d.inputs.ltv).filter((v): v is number => v !== null);
  const dscrs = deals.map((d) => d.inputs.dscr).filter((v): v is number => v !== null);
  const reserves = deals.map((d) => d.structure.reserves).filter((v): v is number => v !== null);

  // Identify top deal-killers from rejected deals (legacy format)
  const rejected = deals.filter((d) => d.outcome === 'rejected');
  const killerReasons: Record<string, number> = {};
  for (const d of rejected) {
    if (d.inputs.dscr !== null && d.inputs.dscr < 1.1) {
      killerReasons['DSCR below 1.10x'] = (killerReasons['DSCR below 1.10x'] || 0) + 1;
    }
    if (d.inputs.ltv !== null && d.inputs.ltv > 0.75) {
      killerReasons['LTV exceeds 75%'] = (killerReasons['LTV exceeds 75%'] || 0) + 1;
    }
    if (d.adjustments.noiAdjustment !== null && d.adjustments.noiAdjustment < -20) {
      killerReasons['NOI haircut >20%'] = (killerReasons['NOI haircut >20%'] || 0) + 1;
    }
    if (d.inputs.vacancy !== null && d.inputs.vacancy > 0.25) {
      killerReasons['Vacancy exceeds 25%'] = (killerReasons['Vacancy exceeds 25%'] || 0) + 1;
    }
  }
  const topDealKillers = Object.entries(killerReasons)
    .map(([reason, frequency]) => ({ reason, frequency }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 10);

  // --- Quantitative Rejection Patterns ---
  // Analyze rejected deals as a training dataset: identify metric thresholds
  // where rejection rates are statistically meaningful.
  const rejectionPatterns: { pattern: string; metric: string; threshold: number | null; rejectionRate: number; sampleSize: number; totalRejected: number; severity: 'critical' | 'high' | 'medium' }[] = [];

  // Helper: test a metric threshold and produce a pattern if significant
  function testThreshold(
    metric: string,
    extractor: (d: typeof deals[0]) => number | null,
    thresholds: number[],
    comparator: 'below' | 'above',
    formatter: (v: number) => string,
  ): void {
    const dealsWithMetric = deals.filter(d => extractor(d) !== null);
    if (dealsWithMetric.length < 3) return;

    for (const thresh of thresholds) {
      const matching = comparator === 'below'
        ? dealsWithMetric.filter(d => extractor(d)! < thresh)
        : dealsWithMetric.filter(d => extractor(d)! > thresh);
      if (matching.length < 2) continue;

      const matchRejected = matching.filter(d => d.outcome === 'rejected');
      const rejRate = round((matchRejected.length / matching.length) * 100, 0);
      if (rejRate < 20) continue; // not meaningful

      const severity: 'critical' | 'high' | 'medium' = rejRate >= 70 ? 'critical' : rejRate >= 45 ? 'high' : 'medium';
      const dir = comparator === 'below' ? '<' : '>';

      rejectionPatterns.push({
        pattern: `Deals with ${metric} ${dir} ${formatter(thresh)} were rejected ${rejRate}% of the time (${matchRejected.length} of ${matching.length} deals)`,
        metric,
        threshold: thresh,
        rejectionRate: rejRate,
        sampleSize: matching.length,
        totalRejected: matchRejected.length,
        severity,
      });
    }
  }

  // DSCR patterns
  testThreshold('DSCR', d => d.inputs.dscr, [1.0, 1.05, 1.10, 1.15, 1.20, 1.25], 'below', v => `${v.toFixed(2)}x`);
  // LTV patterns
  testThreshold('LTV', d => d.inputs.ltv !== null ? d.inputs.ltv * 100 : null, [65, 70, 75, 80], 'above', v => `${v}%`);
  // Vacancy patterns
  testThreshold('Vacancy', d => d.inputs.vacancy !== null ? d.inputs.vacancy * 100 : null, [10, 15, 20, 25, 30], 'above', v => `${v}%`);
  // NOI haircut patterns
  testThreshold('NOI Haircut', d => d.adjustments.noiAdjustment, [-10, -15, -20, -25, -30], 'below', v => `${v}%`);

  // Sort by rejection rate (most dangerous first), deduplicate by keeping highest-rejection per metric
  rejectionPatterns.sort((a, b) => b.rejectionRate - a.rejectionRate);

  // --- Rejected Deal Statistics ---
  const rejectedDSCRs = rejected.map(d => d.inputs.dscr).filter((v): v is number => v !== null);
  const rejectedLTVs = rejected.map(d => d.inputs.ltv).filter((v): v is number => v !== null);
  const rejectedVacancies = rejected.map(d => d.inputs.vacancy).filter((v): v is number => v !== null);
  const rejectedNOIAdjs = rejected.map(d => d.adjustments.noiAdjustment).filter((v): v is number => v !== null);

  const rejectedDealStats = rejected.length >= 2 ? {
    avgDSCR: computeStats(rejectedDSCRs),
    avgLTV: computeStats(rejectedLTVs),
    avgVacancy: computeStats(rejectedVacancies),
    avgNOIHaircut: computeStats(rejectedNOIAdjs),
  } : null;

  return {
    assetType: assetType || 'all',
    totalDeals: deals.length,
    outcomeBreakdown,
    noiHaircut: computeStats(noiAdjs),
    capRateExpansion: computeStats(capRateAdjs),
    maxLTV: computeStats(ltvs),
    avgDSCR: computeStats(dscrs),
    reserveSizes: computeStats(reserves),
    topDealKillers,
    rejectionPatterns,
    rejectedDealStats,
    lastUpdated: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 4. RULE GENERATION — Convert patterns into rules
// ---------------------------------------------------------------------------

const MIN_SAMPLE_SIZE = 5;

function determineConfidence(sampleSize: number): ConfidenceLevel {
  if (sampleSize >= 50) return 'high';
  if (sampleSize >= 15) return 'medium';
  return 'low';
}

export function generateRulesFromPatterns(assetType?: AssetType): LearnedRule[] {
  const insights = computePatternInsights(assetType);
  const newRules: LearnedRule[] = [];
  const now = new Date().toISOString();
  const at = assetType || 'all';
  // Only include qualifying deals: non-child, non-incomplete
  const deals = (assetType
    ? Array.from(historicalUWs.values()).filter((uw) => uw.assetType === assetType)
    : Array.from(historicalUWs.values())
  ).filter(uw => !uw.parentId && uw.dataQuality !== 'incomplete');

  const totalDeals = deals.length;
  if (totalDeals < MIN_SAMPLE_SIZE) return [];

  const rejectedDeals = deals.filter(d => d.outcome === 'rejected');
  const approvedDeals = deals.filter(d => d.outcome === 'approved');

  // Helper: create a rule with outcome-based metrics
  function makeRule(opts: {
    rule: string;
    category: LearnedRule['category'];
    metric: string | null;
    threshold: number | null;
    affectedIds: string[];
    rejectedIds: string[];
    allRelevantIds: string[];
  }): LearnedRule {
    const affected = opts.affectedIds.length;
    const rejectedCount = opts.rejectedIds.length;
    const pctAffected = totalDeals > 0 ? round((affected / totalDeals) * 100, 1) : 0;
    const pctRejected = affected > 0 ? round((rejectedCount / affected) * 100, 1) : 0;
    return {
      id: uuid(),
      rule: opts.rule,
      assetType: at,
      category: opts.category,
      metric: opts.metric,
      threshold: opts.threshold,
      pctDealsAffected: pctAffected,
      pctDealsRejected: pctRejected,
      confidenceLevel: determineConfidence(affected),
      sampleSize: affected,
      supportingDealIds: opts.allRelevantIds,
      status: 'pending',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  // --- DSCR threshold rules ---
  const dscrDeals = deals.filter(d => d.inputs.dscr !== null);
  if (dscrDeals.length >= MIN_SAMPLE_SIZE) {
    const dscrValues = dscrDeals.map(d => d.inputs.dscr!).sort((a, b) => a - b);
    // Find optimal threshold: test percentiles where rejection rate is meaningful
    const thresholds = [1.0, 1.05, 1.10, 1.15, 1.20, 1.25];
    for (const thresh of thresholds) {
      const belowThresh = dscrDeals.filter(d => d.inputs.dscr! < thresh);
      const belowRejected = belowThresh.filter(d => d.outcome === 'rejected');
      if (belowThresh.length >= 3 && belowRejected.length >= 1) {
        const rejPct = round((belowRejected.length / belowThresh.length) * 100, 0);
        newRules.push(makeRule({
          rule: `${formatAssetType(at)} deals with DSCR < ${round(thresh, 2)}x were rejected ${rejPct}% of the time (based on ${belowThresh.length} deals)`,
          category: 'dscr',
          metric: 'DSCR',
          threshold: thresh,
          affectedIds: belowThresh.map(d => d.id),
          rejectedIds: belowRejected.map(d => d.id),
          allRelevantIds: dscrDeals.map(d => d.id),
        }));
      }
    }
    // Also generate the average/range pattern rule
    const avgDSCR = round(dscrValues.reduce((s, v) => s + v, 0) / dscrValues.length, 2);
    const minDSCR = round(dscrValues[0], 2);
    newRules.push(makeRule({
      rule: `${formatAssetType(at)} deals: Average DSCR is ${avgDSCR}x, minimum observed ${minDSCR}x`,
      category: 'dscr',
      metric: 'DSCR',
      threshold: minDSCR,
      affectedIds: dscrDeals.map(d => d.id),
      rejectedIds: dscrDeals.filter(d => d.outcome === 'rejected').map(d => d.id),
      allRelevantIds: dscrDeals.map(d => d.id),
    }));
  }

  // --- LTV threshold rules ---
  const ltvDeals = deals.filter(d => d.inputs.ltv !== null);
  if (ltvDeals.length >= MIN_SAMPLE_SIZE) {
    const thresholds = [0.65, 0.70, 0.75, 0.80, 0.85];
    for (const thresh of thresholds) {
      const aboveThresh = ltvDeals.filter(d => d.inputs.ltv! > thresh);
      const aboveRejected = aboveThresh.filter(d => d.outcome === 'rejected');
      if (aboveThresh.length >= 3 && aboveRejected.length >= 1) {
        const rejPct = round((aboveRejected.length / aboveThresh.length) * 100, 0);
        newRules.push(makeRule({
          rule: `${formatAssetType(at)} deals with LTV > ${round(thresh * 100, 0)}% were rejected ${rejPct}% of the time (based on ${aboveThresh.length} deals)`,
          category: 'ltv',
          metric: 'LTV',
          threshold: thresh,
          affectedIds: aboveThresh.map(d => d.id),
          rejectedIds: aboveRejected.map(d => d.id),
          allRelevantIds: ltvDeals.map(d => d.id),
        }));
      }
    }
    // Average/range pattern rule
    const avgLTV = round(ltvDeals.reduce((s, d) => s + d.inputs.ltv!, 0) / ltvDeals.length * 100, 1);
    const maxLTV = round(Math.max(...ltvDeals.map(d => d.inputs.ltv!)) * 100, 1);
    newRules.push(makeRule({
      rule: `${formatAssetType(at)} deals: Average LTV is ${avgLTV}%, maximum observed ${maxLTV}%`,
      category: 'ltv',
      metric: 'LTV',
      threshold: Math.max(...ltvDeals.map(d => d.inputs.ltv!)),
      affectedIds: ltvDeals.map(d => d.id),
      rejectedIds: ltvDeals.filter(d => d.outcome === 'rejected').map(d => d.id),
      allRelevantIds: ltvDeals.map(d => d.id),
    }));
  }

  // --- Vacancy threshold rules ---
  const vacancyDeals = deals.filter(d => d.inputs.vacancy !== null);
  if (vacancyDeals.length >= MIN_SAMPLE_SIZE) {
    const thresholds = [0.10, 0.15, 0.20, 0.25, 0.30];
    for (const thresh of thresholds) {
      const aboveThresh = vacancyDeals.filter(d => d.inputs.vacancy! > thresh);
      const aboveRejected = aboveThresh.filter(d => d.outcome === 'rejected');
      if (aboveThresh.length >= 3 && aboveRejected.length >= 1) {
        const rejPct = round((aboveRejected.length / aboveThresh.length) * 100, 0);
        newRules.push(makeRule({
          rule: `${formatAssetType(at)} deals with Vacancy > ${round(thresh * 100, 0)}% were rejected ${rejPct}% of the time (based on ${aboveThresh.length} deals)`,
          category: 'vacancy',
          metric: 'Vacancy',
          threshold: thresh,
          affectedIds: aboveThresh.map(d => d.id),
          rejectedIds: aboveRejected.map(d => d.id),
          allRelevantIds: vacancyDeals.map(d => d.id),
        }));
      }
    }
  }

  // --- NOI haircut rules ---
  const noiDeals = deals.filter(d => d.adjustments.noiAdjustment !== null);
  if (noiDeals.length >= MIN_SAMPLE_SIZE) {
    const pct = Math.abs(round(noiDeals.reduce((s, d) => s + d.adjustments.noiAdjustment!, 0) / noiDeals.length, 1));
    // Deals with large NOI haircuts and rejection patterns
    const haircutThresholds = [-10, -15, -20, -25];
    for (const thresh of haircutThresholds) {
      const belowThresh = noiDeals.filter(d => d.adjustments.noiAdjustment! < thresh);
      const belowRejected = belowThresh.filter(d => d.outcome === 'rejected');
      if (belowThresh.length >= 3 && belowRejected.length >= 1) {
        const rejPct = round((belowRejected.length / belowThresh.length) * 100, 0);
        newRules.push(makeRule({
          rule: `${formatAssetType(at)} deals with NOI haircut > ${Math.abs(thresh)}% were rejected ${rejPct}% of the time (based on ${belowThresh.length} deals)`,
          category: 'noi',
          metric: 'NOI Haircut',
          threshold: thresh,
          affectedIds: belowThresh.map(d => d.id),
          rejectedIds: belowRejected.map(d => d.id),
          allRelevantIds: noiDeals.map(d => d.id),
        }));
      }
    }
    // Pattern rule
    const minAdj = round(Math.abs(Math.min(...noiDeals.map(d => d.adjustments.noiAdjustment!))), 1);
    const maxAdj = round(Math.abs(Math.max(...noiDeals.map(d => d.adjustments.noiAdjustment!))), 1);
    newRules.push(makeRule({
      rule: `${formatAssetType(at)} deals: NOI typically adjusted downward by ${pct}% (range ${Math.min(minAdj, maxAdj)}% to ${Math.max(minAdj, maxAdj)}%)`,
      category: 'noi',
      metric: 'NOI Haircut',
      threshold: null,
      affectedIds: noiDeals.map(d => d.id),
      rejectedIds: noiDeals.filter(d => d.outcome === 'rejected').map(d => d.id),
      allRelevantIds: noiDeals.map(d => d.id),
    }));
  }

  // --- Cap rate expansion rules ---
  const capDeals = deals.filter(d => d.adjustments.capRateAdjustment !== null);
  if (capDeals.length >= MIN_SAMPLE_SIZE) {
    const bps = round(capDeals.reduce((s, d) => s + d.adjustments.capRateAdjustment!, 0) / capDeals.length, 0);
    newRules.push(makeRule({
      rule: `${formatAssetType(at)} deals: Cap rate expanded by +${bps}bps on average`,
      category: 'cap_rate',
      metric: 'Cap Rate',
      threshold: null,
      affectedIds: capDeals.map(d => d.id),
      rejectedIds: capDeals.filter(d => d.outcome === 'rejected').map(d => d.id),
      allRelevantIds: capDeals.map(d => d.id),
    }));
  }

  // --- Reserve size rule ---
  if (insights.reserveSizes && insights.reserveSizes.sampleSize >= MIN_SAMPLE_SIZE) {
    const reserveDeals = deals.filter(d => d.structure.reserves !== null);
    const avg = round(insights.reserveSizes.mean, 0);
    newRules.push(makeRule({
      rule: `${formatAssetType(at)} deals: Average reserves of $${avg.toLocaleString()}`,
      category: 'reserves',
      metric: 'Reserves',
      threshold: null,
      affectedIds: reserveDeals.map(d => d.id),
      rejectedIds: reserveDeals.filter(d => d.outcome === 'rejected').map(d => d.id),
      allRelevantIds: reserveDeals.map(d => d.id),
    }));
  }

  // --- Deal-killer rules from top rejection drivers ---
  for (const killer of insights.topDealKillers) {
    if (killer.frequency >= 3) {
      const killerIds = deals.filter(d => d.outcome === 'rejected').map(d => d.id).slice(0, killer.frequency);
      newRules.push(makeRule({
        rule: `${formatAssetType(at)} deals: "${killer.reason}" was a rejection driver in ${killer.frequency} deals`,
        category: 'general',
        metric: null,
        threshold: null,
        affectedIds: killerIds,
        rejectedIds: killerIds,
        allRelevantIds: deals.filter(d => d.outcome === 'rejected').map(d => d.id),
      }));
    }
  }

  // Archive existing approved rules before regeneration (rule versioning)
  const existingForAsset = Array.from(learnedRules.values()).filter(
    (r) => r.assetType === at && r.status === 'approved'
  );
  for (const rule of existingForAsset) {
    archiveRuleVersion(rule, 'regenerated');
  }

  // Store generated rules (clear old pending auto-generated rules for this asset type first)
  const existingManual = Array.from(learnedRules.values()).filter(
    (r) => r.assetType !== at || r.status === 'approved'
  );
  // Re-populate
  learnedRules.clear();
  for (const r of existingManual) learnedRules.set(r.id, r);
  for (const r of newRules) learnedRules.set(r.id, r);
  persistRules();

  // Update rule metadata
  ruleMetadata = {
    lastUpdated: now,
    totalDeals: totalDeals,
    rejected: rejectedDeals.length,
    approved: approvedDeals.length,
    modified: deals.filter(d => d.outcome === 'modified').length,
    ruleCount: newRules.length,
    ruleVersion: (ruleMetadata.ruleVersion || 0) + 1,
  };
  persistRuleMetadata(ruleMetadata);

  return newRules;
}

function formatAssetType(at: AssetType | 'all'): string {
  if (at === 'all') return 'All';
  return at.charAt(0).toUpperCase() + at.slice(1);
}

// ---------------------------------------------------------------------------
// DEAL OUTCOMES UPLOAD — Match uploaded outcome rows to existing UWs
// ---------------------------------------------------------------------------

const OUTCOME_ALIASES: Record<string, DealOutcome> = {
  approved: 'approved',
  approve: 'approved',
  app: 'approved',
  pass: 'approved',
  passed: 'approved',
  funded: 'approved',
  closed: 'approved',
  modified: 'modified',
  mod: 'modified',
  conditional: 'modified',
  conditions: 'modified',
  'approved with conditions': 'modified',
  rejected: 'rejected',
  reject: 'rejected',
  kicked: 'rejected',
  kick: 'rejected',
  declined: 'rejected',
  decline: 'rejected',
  denied: 'rejected',
  failed: 'rejected',
  fail: 'rejected',
  'did not proceed': 'rejected',
  withdrawn: 'rejected',
};

function normalizeOutcome(raw: string | null): DealOutcome | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return OUTCOME_ALIASES[key] ?? null;
}

function normalizeAssetType(raw: string | null): AssetType | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, '_');
  const map: Record<string, AssetType> = {
    office: 'office',
    multifamily: 'multifamily',
    multi_family: 'multifamily',
    apartment: 'multifamily',
    retail: 'retail',
    industrial: 'industrial',
    warehouse: 'industrial',
    hotel: 'hotel',
    hospitality: 'hotel',
    self_storage: 'self_storage',
    storage: 'self_storage',
    mixed_use: 'mixed_use',
    mixed: 'mixed_use',
    manufactured_housing: 'manufactured_housing',
    mhc: 'manufactured_housing',
    mobile_home: 'manufactured_housing',
  };
  return map[key] ?? null;
}

/**
 * Parses an Excel file of rejected/kicked deals, matches each row to an existing
 * UW record in the library, labels the UW as rejected, and triggers rule
 * recalculation. Every row is treated as a rejection — the outcome column is
 * optional and defaults to 'rejected'. If an outcome column IS present, it is
 * still normalized, but absent/empty values default to 'rejected'.
 * Does NOT remove or modify any existing data beyond updating the outcome field
 * and notes on matched UWs.
 */
export function ingestDealOutcomes(buffer: Buffer, fileName: string): DealOutcomesUploadResult {
  // ---- 1. Parse Excel to rows ----
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (rawRows.length === 0) {
    return {
      fileName,
      totalRows: 0,
      matched: 0,
      needsReview: 0,
      unmatched: 0,
      applied: 0,
      affectedAssetTypes: [],
      matches: [],
      uploadedAt: new Date().toISOString(),
    };
  }

  // ---- 2. Map columns (flexible header matching) ----
  const headerMap = buildHeaderMap(Object.keys(rawRows[0]));

  const parsedRows: DealOutcomeRow[] = rawRows.map((row, idx) => {
    const missing: string[] = [];
    const get = (field: string): string | null => {
      const col = headerMap[field];
      if (!col) { missing.push(field); return null; }
      const val = row[col];
      return val !== undefined && val !== null && String(val).trim() !== '' ? String(val).trim() : null;
    };

    const loanAmountRaw = get('loanAmount');
    let loanAmount: number | null = null;
    if (loanAmountRaw) {
      const parsed = parseFloat(loanAmountRaw.replace(/[$,]/g, ''));
      if (!isNaN(parsed)) loanAmount = parsed;
    }

    const yearRaw = get('year');
    let year: number | null = null;
    if (yearRaw) {
      const parsed = parseInt(yearRaw, 10);
      if (!isNaN(parsed) && parsed > 1990 && parsed < 2100) year = parsed;
    }

    return {
      rowIndex: idx + 2, // 1-indexed + header row
      dealName: get('dealName'),
      propertyName: get('propertyName'),
      loanAmount,
      city: get('city'),
      state: get('state'),
      assetClass: get('assetClass'),
      year,
      outcome: get('outcome'),
      kickReason: get('kickReason'),
      notes: get('notes'),
      missingFields: missing,
    };
  });

  // ---- 3. Match each row to existing UWs ----
  const allUWs = Array.from(historicalUWs.values());
  const matches: DealOutcomeMatch[] = [];
  const affectedAssetTypes = new Set<AssetType>();
  let applied = 0;
  const now = new Date().toISOString();

  for (const row of parsedRows) {
    const searchName = row.dealName || row.propertyName || '';
    const normalizedOutcome = normalizeOutcome(row.outcome) || 'rejected';
    const normalizedAsset = normalizeAssetType(row.assetClass);

    if (!searchName && !row.loanAmount) {
      // Nothing to match on — store as unmatched outcome
      const unmatchedId = uuid();
      unmatchedOutcomes.set(unmatchedId, {
        id: unmatchedId,
        sourceFileName: fileName,
        sourceRowId: row.rowIndex,
        dealName: row.dealName,
        propertyName: row.propertyName,
        loanAmount: row.loanAmount,
        city: row.city,
        state: row.state,
        assetClass: row.assetClass,
        year: row.year,
        outcome: normalizedOutcome,
        kickReason: row.kickReason,
        notes: row.notes,
        linkedUWId: null,
        linkedAt: null,
        uploadedAt: now,
      });
      matches.push({
        rowIndex: row.rowIndex,
        dealName: searchName || '(empty)',
        assetClass: row.assetClass || 'unknown',
        year: row.year,
        outcome: normalizedOutcome || 'rejected',
        kickReason: row.kickReason,
        notes: row.notes,
        matchedUWId: null,
        matchedDealName: null,
        matchConfidence: 'none',
        reviewStatus: 'unmatched',
        matchScore: 0,
        applied: false,
      });
      continue;
    }

    // Score every UW and find best match — weighted confidence model
    let bestMatch: HistoricalUnderwriting | null = null;
    let bestScore = 0;
    let bestMatchedFields: string[] = [];

    for (const uw of allUWs) {
      let score = 0;
      let factors = 0;
      const fieldsUsed: string[] = [];

      // Deal Name — highest weight (5)
      if (row.dealName) {
        const nameSim = normalizedSimilarity(row.dealName, uw.dealName);
        score += nameSim * 5;
        factors += 5;
        if (nameSim > 0.5) fieldsUsed.push('dealName');
      }

      // Property Name — high weight (3)
      if (row.propertyName) {
        const propSim = normalizedSimilarity(row.propertyName, uw.dealName);
        score += propSim * 3;
        factors += 3;
        if (propSim > 0.5) fieldsUsed.push('propertyName');
      }

      // City match (2)
      if (row.city && uw.city && uw.city !== 'Unknown / Needs Review') {
        const citySim = normalizedSimilarity(row.city, uw.city);
        score += citySim * 2;
        factors += 2;
        if (citySim > 0.7) fieldsUsed.push('city');
      }

      // State match (1.5)
      if (row.state && uw.state && uw.state !== 'Unknown / Needs Review') {
        const stateMatch = row.state.trim().toLowerCase() === uw.state.trim().toLowerCase() ? 1 : 0;
        score += stateMatch * 1.5;
        factors += 1.5;
        if (stateMatch) fieldsUsed.push('state');
      }

      // Asset class match (1.5)
      if (normalizedAsset && uw.assetType) {
        const assetMatch = normalizedAsset === uw.assetType ? 1 : 0;
        score += assetMatch * 1.5;
        factors += 1.5;
        if (assetMatch) fieldsUsed.push('assetClass');
      }

      // Loan amount proximity (2)
      if (row.loanAmount && uw.inputs.loanAmount) {
        const diff = Math.abs(row.loanAmount - uw.inputs.loanAmount) / Math.max(row.loanAmount, uw.inputs.loanAmount);
        const loanSim = 1 - Math.min(diff, 1);
        score += loanSim * 2;
        factors += 2;
        if (loanSim > 0.8) fieldsUsed.push('loanAmount');
      }

      // Year match (1)
      if (row.year && uw.year) {
        const yearDiff = Math.abs(row.year - uw.year);
        const yearSim = yearDiff === 0 ? 1 : yearDiff <= 1 ? 0.5 : 0;
        score += yearSim * 1;
        factors += 1;
        if (yearSim > 0) fieldsUsed.push('year');
      }

      const normalizedScore = factors > 0 ? score / factors : 0;
      if (normalizedScore > bestScore) {
        bestScore = normalizedScore;
        bestMatch = uw;
        bestMatchedFields = fieldsUsed;
      }
    }

    // Convert to 0-100 percentage for threshold comparison
    const pctScore = round(bestScore * 100, 1);

    // Determine confidence from score (per spec thresholds)
    //   90–100% → AUTO MATCH
    //   70–89%  → PROBABLE MATCH (flag for review)
    //   Below 70% → DO NOT MATCH
    let confidence: OutcomeMatchConfidence;
    let reviewStatus: OutcomeReviewStatus;
    if (pctScore >= 90) {
      confidence = 'high';
      reviewStatus = 'matched';
    } else if (pctScore >= 70) {
      confidence = 'medium';
      reviewStatus = 'needs_review';
    } else {
      confidence = 'none';
      reviewStatus = 'unmatched';
    }

    // Apply outcome to matched UW (only for auto-match 90%+)
    let didApply = false;
    if (bestMatch && confidence === 'high') {
      bestMatch.outcome = normalizedOutcome;
      bestMatch.outcomeSource = 'Kicks File Match';
      bestMatch.outcomeConfidence = pctScore;
      bestMatch.kickMatchId = row.rowIndex;
      bestMatch.outcomeAudit = {
        sourceFileName: fileName,
        sourceRowId: row.rowIndex,
        matchConfidence: pctScore,
        matchedFields: bestMatchedFields,
        matchedAt: now,
      };
      if (row.kickReason) {
        bestMatch.notes = bestMatch.notes
          ? `${bestMatch.notes}\nKick reason: ${row.kickReason}`
          : `Kick reason: ${row.kickReason}`;
      }
      if (row.notes) {
        bestMatch.notes = bestMatch.notes
          ? `${bestMatch.notes}\nOutcome notes: ${row.notes}`
          : `Outcome notes: ${row.notes}`;
      }
      bestMatch.updatedAt = now;
      historicalUWs.set(bestMatch.id, bestMatch);
      affectedAssetTypes.add(bestMatch.assetType);
      didApply = true;
      applied++;
    }

    // Store unmatched rows for manual linking
    if (reviewStatus === 'unmatched') {
      const unmatchedId = uuid();
      unmatchedOutcomes.set(unmatchedId, {
        id: unmatchedId,
        sourceFileName: fileName,
        sourceRowId: row.rowIndex,
        dealName: row.dealName,
        propertyName: row.propertyName,
        loanAmount: row.loanAmount,
        city: row.city,
        state: row.state,
        assetClass: row.assetClass,
        year: row.year,
        outcome: normalizedOutcome,
        kickReason: row.kickReason,
        notes: row.notes,
        linkedUWId: null,
        linkedAt: null,
        uploadedAt: now,
      });
    }

    matches.push({
      rowIndex: row.rowIndex,
      dealName: row.dealName || row.propertyName || '(unknown)',
      assetClass: normalizedAsset || row.assetClass || 'unknown',
      year: row.year,
      outcome: normalizedOutcome || 'rejected',
      kickReason: row.kickReason,
      notes: row.notes,
      matchedUWId: bestMatch && confidence !== 'none' ? bestMatch.id : null,
      matchedDealName: bestMatch && confidence !== 'none' ? bestMatch.dealName : null,
      matchConfidence: confidence,
      reviewStatus,
      matchScore: round(bestScore, 3),
      applied: didApply,
    });
  }

  // ---- 4. Persist and trigger rule recalculation ----
  if (applied > 0) {
    persistUWs();
    triggerBackgroundRuleUpdate([...affectedAssetTypes]);
  }
  persistUnmatchedOutcomes();

  const result: DealOutcomesUploadResult = {
    fileName,
    totalRows: parsedRows.length,
    matched: matches.filter(m => m.reviewStatus === 'matched').length,
    needsReview: matches.filter(m => m.reviewStatus === 'needs_review').length,
    unmatched: matches.filter(m => m.reviewStatus === 'unmatched').length,
    applied,
    affectedAssetTypes: [...affectedAssetTypes],
    matches,
    uploadedAt: new Date().toISOString(),
  };

  console.log(`[UW Intelligence] Outcomes upload: ${result.totalRows} rows, ${result.matched} auto-matched (90%+), ${result.needsReview} probable (70-89%), ${result.unmatched} unmatched (<70%), ${result.applied} applied`);

  return result;
}

/**
 * Apply a specific outcome match that was flagged "needs_review" after manual
 * user confirmation. This writes the outcome onto the matched UW record.
 */
export function applyOutcomeMatch(
  uwId: string,
  outcome: DealOutcome,
  kickReason: string | null,
  notes: string | null,
  sourceFileName?: string,
  sourceRowId?: number,
  matchScore?: number,
): boolean {
  const uw = historicalUWs.get(uwId);
  if (!uw) return false;

  uw.outcome = outcome;
  uw.outcomeSource = sourceFileName ? 'Kicks File Match (Manual Review)' : 'Manual Override';
  uw.outcomeConfidence = matchScore != null ? round(matchScore * 100, 1) : null;
  uw.kickMatchId = sourceRowId ?? null;
  if (sourceFileName && sourceRowId != null) {
    uw.outcomeAudit = {
      sourceFileName,
      sourceRowId,
      matchConfidence: matchScore != null ? round(matchScore * 100, 1) : 0,
      matchedFields: ['manual_review'],
      matchedAt: new Date().toISOString(),
    };
  }
  if (kickReason) {
    uw.notes = uw.notes ? `${uw.notes}\nKick reason: ${kickReason}` : `Kick reason: ${kickReason}`;
  }
  if (notes) {
    uw.notes = uw.notes ? `${uw.notes}\nOutcome notes: ${notes}` : `Outcome notes: ${notes}`;
  }
  uw.updatedAt = new Date().toISOString();
  historicalUWs.set(uwId, uw);
  persistUWs();
  triggerBackgroundRuleUpdate([uw.assetType]);
  return true;
}

// ---------------------------------------------------------------------------
// UNMATCHED OUTCOMES MANAGEMENT
// ---------------------------------------------------------------------------

export function listUnmatchedOutcomes(): UnmatchedOutcome[] {
  return Array.from(unmatchedOutcomes.values()).filter(o => !o.linkedUWId);
}

export function getUnmatchedOutcome(id: string): UnmatchedOutcome | null {
  return unmatchedOutcomes.get(id) || null;
}

/**
 * Manually link an unmatched outcome to a UW record. This applies the outcome
 * to the UW and marks the unmatched record as linked.
 */
export function linkUnmatchedOutcome(
  unmatchedId: string,
  uwId: string,
): boolean {
  const unmatched = unmatchedOutcomes.get(unmatchedId);
  if (!unmatched) return false;

  const uw = historicalUWs.get(uwId);
  if (!uw) return false;

  const now = new Date().toISOString();

  // Apply outcome to the UW record
  uw.outcome = unmatched.outcome;
  uw.outcomeSource = 'Kicks File Match (Manual Link)';
  uw.outcomeConfidence = null;
  uw.kickMatchId = unmatched.sourceRowId;
  uw.outcomeAudit = {
    sourceFileName: unmatched.sourceFileName,
    sourceRowId: unmatched.sourceRowId,
    matchConfidence: 0,
    matchedFields: ['manual_link'],
    matchedAt: now,
  };
  if (unmatched.kickReason) {
    uw.notes = uw.notes ? `${uw.notes}\nKick reason: ${unmatched.kickReason}` : `Kick reason: ${unmatched.kickReason}`;
  }
  if (unmatched.notes) {
    uw.notes = uw.notes ? `${uw.notes}\nOutcome notes: ${unmatched.notes}` : `Outcome notes: ${unmatched.notes}`;
  }
  uw.updatedAt = now;
  historicalUWs.set(uwId, uw);

  // Mark the unmatched record as linked
  unmatched.linkedUWId = uwId;
  unmatched.linkedAt = now;
  unmatchedOutcomes.set(unmatchedId, unmatched);

  persistUWs();
  persistUnmatchedOutcomes();
  triggerBackgroundRuleUpdate([uw.assetType]);
  return true;
}

export function deleteUnmatchedOutcome(id: string): boolean {
  if (!unmatchedOutcomes.has(id)) return false;
  unmatchedOutcomes.delete(id);
  persistUnmatchedOutcomes();
  return true;
}

/**
 * Flexible header mapping — handles many common column name variations.
 */
function buildHeaderMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const patterns: Record<string, RegExp> = {
    dealName: /deal[\s_-]?name|deal|loan[\s_-]?name/i,
    propertyName: /property[\s_-]?name|property|asset[\s_-]?name/i,
    loanAmount: /loan[\s_-]?amount|loan[\s_-]?size|amount|balance/i,
    city: /city|market/i,
    state: /state|st/i,
    assetClass: /asset[\s_-]?class|asset[\s_-]?type|property[\s_-]?type|type/i,
    year: /year|vintage|date/i,
    outcome: /outcome|result|status|decision|disposition/i,
    kickReason: /kick[\s_-]?reason|reason|rejection[\s_-]?reason|decline[\s_-]?reason|why/i,
    notes: /notes|comments|remarks/i,
  };

  for (const [field, regex] of Object.entries(patterns)) {
    for (const header of headers) {
      if (regex.test(header.trim())) {
        map[field] = header;
        break;
      }
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// POST-INGESTION INTELLIGENCE UPDATE
// ---------------------------------------------------------------------------

export function postIngestionIntelligenceUpdate(affectedAssetTypes: AssetType[]): { updated: string[]; skipped: string[] } {
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const assetType of affectedAssetTypes) {
    // Only include non-child, non-incomplete records in pattern analysis
    const qualifyingDeals = Array.from(historicalUWs.values()).filter(
      uw => uw.assetType === assetType && !uw.parentId && uw.dataQuality !== 'incomplete'
    );

    if (qualifyingDeals.length < MIN_SAMPLE_SIZE) {
      skipped.push(assetType);
      continue;
    }

    // Check if pattern is statistically consistent (stdDev not too high relative to mean)
    const insights = computePatternInsights(assetType);
    const confidence = determineConfidence(qualifyingDeals.length);
    if (confidence === 'low') {
      skipped.push(assetType);
      continue;
    }

    // Generate updated rules
    generateRulesFromPatterns(assetType);
    updated.push(assetType);
    console.log(`[UW Intelligence] Auto-updated rules for ${assetType} (${qualifyingDeals.length} qualifying deals)`);
  }

  return { updated, skipped };
}

// ---------------------------------------------------------------------------
// 5. APPLY INTELLIGENCE — Apply learned rules to a new deal
// ---------------------------------------------------------------------------

export function applyIntelligence(
  assetType: AssetType,
  dealInputs: {
    noi?: number;
    capRate?: number;
    ltv?: number;
    dscr?: number;
    vacancy?: number;
    reserves?: number;
  }
): AppliedIntelligence {
  const rules = listLearnedRules(assetType).filter((r) => r.status === 'approved');
  const insights = computePatternInsights(assetType);

  const adjustments: AppliedIntelligence['adjustments'] = [];
  const redFlags: AppliedIntelligence['redFlags'] = [];
  const benchmarks: AppliedIntelligence['benchmarks'] = [];

  // NOI adjustment suggestion
  if (insights.noiHaircut && insights.noiHaircut.sampleSize >= MIN_SAMPLE_SIZE && dealInputs.noi) {
    const rule = rules.find((r) => r.category === 'noi');
    if (rule) {
      adjustments.push({
        label: 'NOI adjustment',
        value: round(insights.noiHaircut.mean, 1),
        unit: '%',
        basis: `Based on ${insights.noiHaircut.sampleSize} prior ${assetType} deals`,
        ruleId: rule.id,
        confidence: rule.confidenceLevel,
      });
    }
  }

  // Cap rate expansion suggestion
  if (insights.capRateExpansion && insights.capRateExpansion.sampleSize >= MIN_SAMPLE_SIZE && dealInputs.capRate) {
    const rule = rules.find((r) => r.category === 'cap_rate');
    if (rule) {
      adjustments.push({
        label: 'Cap rate expansion',
        value: round(insights.capRateExpansion.mean, 0),
        unit: 'bps',
        basis: `Based on ${insights.capRateExpansion.sampleSize} prior ${assetType} deals`,
        ruleId: rule.id,
        confidence: rule.confidenceLevel,
      });
    }
  }

  // Red flags from DSCR
  if (dealInputs.dscr !== undefined && insights.avgDSCR) {
    const rejRule = rules.find((r) => r.category === 'dscr' && r.rule.includes('rejected'));
    if (rejRule && dealInputs.dscr < insights.avgDSCR.min) {
      redFlags.push({
        flag: `DSCR of ${dealInputs.dscr}x is below historical minimum of ${insights.avgDSCR.min}x`,
        basis: `Based on ${rejRule.sampleSize} rejected deals`,
        ruleId: rejRule.id,
        severity: 'critical',
      });
    } else if (dealInputs.dscr < insights.avgDSCR.mean) {
      const dscrRule = rules.find((r) => r.category === 'dscr' && !r.rule.includes('rejected'));
      if (dscrRule) {
        redFlags.push({
          flag: `DSCR of ${dealInputs.dscr}x is below historical average of ${insights.avgDSCR.mean}x`,
          basis: `Based on ${dscrRule.sampleSize} prior deals`,
          ruleId: dscrRule.id,
          severity: 'high',
        });
      }
    }
  }

  // Red flags from LTV
  if (dealInputs.ltv !== undefined && insights.maxLTV) {
    if (dealInputs.ltv > insights.maxLTV.max) {
      const ltvRule = rules.find((r) => r.category === 'ltv');
      if (ltvRule) {
        redFlags.push({
          flag: `LTV of ${round(dealInputs.ltv * 100, 1)}% exceeds historical maximum of ${round(insights.maxLTV.max * 100, 1)}%`,
          basis: `Based on ${ltvRule.sampleSize} prior deals`,
          ruleId: ltvRule.id,
          severity: 'critical',
        });
      }
    }
  }

  // Benchmarks
  if (dealInputs.noi && insights.noiHaircut) {
    benchmarks.push({
      metric: 'NOI Haircut',
      dealValue: 0, // will be filled by caller
      historicalAvg: insights.noiHaircut.mean,
      historicalRange: `${round(insights.noiHaircut.min, 1)}% to ${round(insights.noiHaircut.max, 1)}%`,
      assessment: 'within_norms',
    });
  }
  if (dealInputs.capRate && insights.capRateExpansion) {
    benchmarks.push({
      metric: 'Cap Rate Expansion',
      dealValue: 0,
      historicalAvg: insights.capRateExpansion.mean,
      historicalRange: `${round(insights.capRateExpansion.min, 0)}bps to ${round(insights.capRateExpansion.max, 0)}bps`,
      assessment: 'within_norms',
    });
  }
  if (dealInputs.dscr && insights.avgDSCR) {
    const assessment = dealInputs.dscr < insights.avgDSCR.mean - insights.avgDSCR.stdDev
      ? 'aggressive'
      : dealInputs.dscr > insights.avgDSCR.mean + insights.avgDSCR.stdDev
        ? 'conservative'
        : 'within_norms';
    benchmarks.push({
      metric: 'DSCR',
      dealValue: dealInputs.dscr,
      historicalAvg: insights.avgDSCR.mean,
      historicalRange: `${insights.avgDSCR.min}x to ${insights.avgDSCR.max}x`,
      assessment,
    });
  }
  if (dealInputs.ltv && insights.maxLTV) {
    const assessment = dealInputs.ltv > insights.maxLTV.mean + insights.maxLTV.stdDev
      ? 'aggressive'
      : dealInputs.ltv < insights.maxLTV.mean - insights.maxLTV.stdDev
        ? 'conservative'
        : 'within_norms';
    benchmarks.push({
      metric: 'LTV',
      dealValue: round(dealInputs.ltv * 100, 1),
      historicalAvg: round(insights.maxLTV.mean * 100, 1),
      historicalRange: `${round(insights.maxLTV.min * 100, 1)}% to ${round(insights.maxLTV.max * 100, 1)}%`,
      assessment,
    });
  }

  return { adjustments, redFlags, benchmarks };
}

// ---------------------------------------------------------------------------
// 6. DATA SUFFICIENCY CHECK
// ---------------------------------------------------------------------------

export function getDataSufficiency(assetType?: AssetType): {
  sufficient: boolean;
  totalDeals: number;
  minimumRequired: number;
  message: string;
} {
  const deals = assetType
    ? Array.from(historicalUWs.values()).filter((uw) => uw.assetType === assetType)
    : Array.from(historicalUWs.values());

  const sufficient = deals.length >= MIN_SAMPLE_SIZE;
  return {
    sufficient,
    totalDeals: deals.length,
    minimumRequired: MIN_SAMPLE_SIZE,
    message: sufficient
      ? `${deals.length} deals available — sufficient data for pattern extraction.`
      : `Only ${deals.length} of ${MIN_SAMPLE_SIZE} minimum deals uploaded. Upload more underwriting files to enable pattern extraction.`,
  };
}

// ---------------------------------------------------------------------------
// 7. MARKET INTELLIGENCE — Aggregate to market / sub-market level
// ---------------------------------------------------------------------------

interface MarketIntelligenceFilters {
  assetType?: AssetType;
  state?: string;
  city?: string;
  yearMin?: number;
  yearMax?: number;
}

/**
 * Groups deals by city + state + assetType and aggregates all broker narratives
 * and underwriting data into market-level intelligence. No deal-level info is exposed.
 */
export function computeMarketIntelligence(filters?: MarketIntelligenceFilters): MarketIntelligence[] {
  let deals = Array.from(historicalUWs.values());

  // Apply filters
  if (filters?.assetType) deals = deals.filter((d) => d.assetType === filters.assetType);
  if (filters?.state) deals = deals.filter((d) => d.state === filters.state);
  if (filters?.city) deals = deals.filter((d) => d.city === filters.city);
  if (filters?.yearMin) deals = deals.filter((d) => d.year >= filters.yearMin!);
  if (filters?.yearMax) deals = deals.filter((d) => d.year <= filters.yearMax!);

  // Group by city + state + assetType
  const groups = new Map<string, HistoricalUnderwriting[]>();
  for (const d of deals) {
    if (d.city === 'Unknown / Needs Review' || d.state === 'Unknown / Needs Review') continue;
    const key = `${d.city}_${d.state}_${d.assetType}`;
    const existing = groups.get(key);
    if (existing) existing.push(d);
    else groups.set(key, [d]);
  }

  const results: MarketIntelligence[] = [];

  for (const [key, groupDeals] of groups) {
    const first = groupDeals[0];
    const city = first.city;
    const state = first.state;
    const assetType = first.assetType;

    // Collect all narratives from this market group
    const allNarratives: BrokerNarrative[] = [];
    for (const d of groupDeals) {
      for (const n of (d.brokerNarratives || [])) {
        allNarratives.push(n);
      }
    }

    // Collect sub-markets
    const subMarkets = [...new Set(
      allNarratives.map((n) => n.subMarket).filter((s) => s && s !== 'Unknown / Needs Review')
    )];

    // --- Rent Overview ---
    const rents = groupDeals.map((d) => d.inputs.rents).filter((v): v is number => v !== null);
    const rentOverview = aggregateRentOverview(rents, allNarratives, assetType);

    // --- Vacancy & Occupancy ---
    const vacancies = groupDeals.map((d) => d.inputs.vacancy).filter((v): v is number => v !== null);
    const vacancyOverview = aggregateVacancyOverview(vacancies, allNarratives);

    // --- Supply & Demand ---
    const supplyDemand = aggregateSupplyDemand(allNarratives);

    // --- Broker Sentiment ---
    const brokerSentiment = aggregateBrokerSentiment(allNarratives);

    // --- Key Themes ---
    const keyThemes = extractKeyThemes(allNarratives);

    // --- Sources ---
    const years = groupDeals.map((d) => d.year);
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    const excerpts = allNarratives
      .filter((n) => n.excerpt)
      .slice(0, 3)
      .map((n) => n.excerpt.length > 200 ? n.excerpt.slice(0, 200) + '...' : n.excerpt);
    const pageRefs = [...new Set(
      allNarratives
        .filter((n) => n.sourcePage !== 'Unknown')
        .map((n) => `${n.sourceSection !== 'Unknown' ? n.sourceSection + ' — ' : ''}${n.sourcePage}`)
    )].slice(0, 5);

    results.push({
      marketKey: key,
      displayName: `${city.toUpperCase()} — ${formatAssetType(assetType).toUpperCase()}`,
      city,
      state,
      assetType,
      subMarkets,
      rentOverview,
      vacancyOverview,
      supplyDemand,
      brokerSentiment,
      keyThemes,
      sources: {
        fileCount: groupDeals.length,
        yearRange: minYear === maxYear ? `${minYear}` : `${minYear}–${maxYear}`,
        excerpts,
        pageReferences: pageRefs,
      },
      lastUpdated: new Date().toISOString(),
    });
  }

  // Sort by number of source files (most data first)
  results.sort((a, b) => b.sources.fileCount - a.sources.fileCount);
  return results;
}

/**
 * The "rents" field from AI extraction is unreliable — it can be total annual
 * revenue ($21M) or a per-unit/psf rate ($162).  We filter to plausible
 * per-unit / psf values only.  Thresholds by asset class:
 *   - multifamily / manufactured_housing: $200 – $15,000 per unit (monthly)
 *   - hotel (ADR): $50 – $1,500
 *   - self_storage: $20 – $500 per unit
 *   - office / retail / industrial / mixed_use: $5 – $500 psf (annual)
 * Everything else is likely total income and gets excluded.
 */
function plausibleRentRange(assetType: AssetType): [number, number] {
  switch (assetType) {
    case 'multifamily':
    case 'manufactured_housing':
      return [200, 15000];
    case 'hotel':
      return [50, 1500];
    case 'self_storage':
      return [20, 500];
    default: // office, retail, industrial, mixed_use
      return [5, 500];
  }
}

function aggregateRentOverview(
  rents: number[],
  narratives: BrokerNarrative[],
  assetType: AssetType
): MarketIntelligence['rentOverview'] {
  const isPerUnit = ['multifamily', 'manufactured_housing', 'self_storage', 'hotel'].includes(assetType);
  const rentUnit = isPerUnit ? 'per unit' : 'psf';

  // Filter to plausible per-unit / psf values only
  const [lo, hi] = plausibleRentRange(assetType);
  const plausible = rents.filter((v) => v >= lo && v <= hi);

  let avgRentLow: number | null = null;
  let avgRentHigh: number | null = null;
  if (plausible.length > 0) {
    const sorted = [...plausible].sort((a, b) => a - b);
    avgRentLow = round(sorted[0], 0);
    avgRentHigh = round(sorted[sorted.length - 1], 0);
  }

  // Also try to extract dollar figures from narrative text
  const narrativeRents = extractRentFiguresFromNarratives(narratives, lo, hi);
  if (narrativeRents.length > 0) {
    const allRents = [...plausible, ...narrativeRents].sort((a, b) => a - b);
    avgRentLow = round(allRents[0], 0);
    avgRentHigh = round(allRents[allRents.length - 1], 0);
  }

  // Analyze narrative text for rent trends
  const allText = narratives.map((n) =>
    `${n.marketNarrative} ${n.subMarketNarrative}`
  ).join(' ').toLowerCase();

  let trend: RentTrend = 'mixed';
  const increasing = countKeywords(allText, ['rent growth', 'rents increasing', 'rent increases', 'rising rents', 'upward pressure', 'rent escalation']);
  const declining = countKeywords(allText, ['rent decline', 'rents declining', 'rent decrease', 'downward pressure', 'rent concessions', 'rent reduction', 'falling rents']);
  const stabilizing = countKeywords(allText, ['stabilizing', 'stable rents', 'flat rents', 'rents flat', 'rent plateau']);

  if (increasing > declining && increasing > stabilizing) trend = 'increasing';
  else if (declining > increasing && declining > stabilizing) trend = 'declining';
  else if (stabilizing > 0 && stabilizing >= increasing && stabilizing >= declining) trend = 'stabilizing';

  // Build trend narrative from actual commentary
  const rentNarratives = narratives
    .filter((n) => {
      const t = `${n.marketNarrative} ${n.subMarketNarrative}`.toLowerCase();
      return t.includes('rent') || t.includes('lease rate') || t.includes('asking rate')
        || t.includes('psf') || t.includes('per unit') || t.includes('adr') || t.includes('rate');
    })
    .map((n) => n.marketNarrative || n.subMarketNarrative)
    .filter(Boolean);

  let trendNarrative: string;
  if (rentNarratives.length > 0) {
    trendNarrative = summarizeNarratives(rentNarratives, 'rent');
  } else if (avgRentLow !== null) {
    trendNarrative = `Observed rent range: $${avgRentLow.toLocaleString()} – $${avgRentHigh?.toLocaleString()} ${rentUnit}`;
  } else {
    trendNarrative = 'Rent data available in source files but not extractable as per-unit rates. See source excerpts below.';
  }

  return { avgRentLow, avgRentHigh, rentUnit, trend, trendNarrative };
}

/** Scan narrative text for dollar figures that look like per-unit/psf rents */
function extractRentFiguresFromNarratives(narratives: BrokerNarrative[], lo: number, hi: number): number[] {
  const figures: number[] = [];
  const dollarRegex = /\$\s?([\d,]+(?:\.\d{1,2})?)/g;
  for (const n of narratives) {
    const text = `${n.marketNarrative} ${n.subMarketNarrative} ${n.excerpt}`;
    let match;
    while ((match = dollarRegex.exec(text)) !== null) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(val) && val >= lo && val <= hi) {
        figures.push(val);
      }
    }
  }
  return figures;
}

function aggregateVacancyOverview(
  vacancies: number[],
  narratives: BrokerNarrative[]
): MarketIntelligence['vacancyOverview'] {
  // Normalize: if value > 1 it was stored as a percentage (e.g. 15 instead of 0.15)
  const normalized = vacancies
    .map((v) => v > 1 ? v / 100 : v)
    .filter((v) => v >= 0 && v <= 1);  // sanity: 0–100%

  let vacancyLow: number | null = null;
  let vacancyHigh: number | null = null;
  if (normalized.length > 0) {
    const sorted = [...normalized].sort((a, b) => a - b);
    vacancyLow = round(sorted[0], 4);
    vacancyHigh = round(sorted[sorted.length - 1], 4);
  }

  const vacNarratives = narratives
    .filter((n) => {
      const t = `${n.marketNarrative} ${n.subMarketNarrative}`.toLowerCase();
      return t.includes('vacanc') || t.includes('occupanc') || t.includes('absorption');
    })
    .map((n) => n.marketNarrative || n.subMarketNarrative)
    .filter(Boolean);

  const occupancyTrend = vacNarratives.length > 0
    ? summarizeNarratives(vacNarratives, 'vacancy/occupancy')
    : vacancyLow !== null ? `Vacancy range: ${(vacancyLow * 100).toFixed(1)}% – ${((vacancyHigh || 0) * 100).toFixed(1)}%` : 'Insufficient vacancy data';

  return { vacancyLow, vacancyHigh, occupancyTrend };
}

function aggregateSupplyDemand(narratives: BrokerNarrative[]): MarketIntelligence['supplyDemand'] {
  const allTexts = narratives.map((n) => `${n.marketNarrative} ${n.subMarketNarrative}`.toLowerCase());

  const supplyNarrs = narratives.filter((_, i) =>
    allTexts[i].includes('supply') || allTexts[i].includes('pipeline') || allTexts[i].includes('construction') || allTexts[i].includes('development') || allTexts[i].includes('deliveries')
  ).map((n) => n.marketNarrative || n.subMarketNarrative).filter(Boolean);

  const demandNarrs = narratives.filter((_, i) =>
    allTexts[i].includes('demand') || allTexts[i].includes('tenant') || allTexts[i].includes('leasing activity') || allTexts[i].includes('migration')
  ).map((n) => n.marketNarrative || n.subMarketNarrative).filter(Boolean);

  const devNarrs = narratives.filter((_, i) =>
    allTexts[i].includes('new development') || allTexts[i].includes('pipeline') || allTexts[i].includes('under construction') || allTexts[i].includes('planned') || allTexts[i].includes('deliveries')
  ).map((n) => n.marketNarrative || n.subMarketNarrative).filter(Boolean);

  const absNarrs = narratives.filter((_, i) =>
    allTexts[i].includes('absorption') || allTexts[i].includes('net absorption')
  ).map((n) => n.marketNarrative || n.subMarketNarrative).filter(Boolean);

  return {
    supplyNarrative: supplyNarrs.length > 0 ? summarizeNarratives(supplyNarrs, 'supply') : 'No supply commentary available',
    demandNarrative: demandNarrs.length > 0 ? summarizeNarratives(demandNarrs, 'demand') : 'No demand commentary available',
    newDevelopment: devNarrs.length > 0 ? summarizeNarratives(devNarrs, 'development pipeline') : 'No development pipeline data',
    absorptionTrend: absNarrs.length > 0 ? summarizeNarratives(absNarrs, 'absorption') : 'No absorption data',
  };
}

function aggregateBrokerSentiment(narratives: BrokerNarrative[]): MarketIntelligence['brokerSentiment'] {
  const allText = narratives.map((n) => `${n.marketNarrative} ${n.subMarketNarrative}`).join(' ').toLowerCase();

  const positiveKeywords = ['strong demand', 'rent growth', 'low vacancy', 'high occupancy', 'favorable', 'robust',
    'improving', 'tightening', 'positive', 'bullish', 'outperforming', 'healthy', 'growing', 'expansion'];
  const negativeKeywords = ['declining', 'oversupply', 'high vacancy', 'weak demand', 'softening', 'deteriorating',
    'challenging', 'negative', 'bearish', 'concern', 'risk', 'downturn', 'pressure', 'contraction', 'distress',
    'elevated vacancy', 'concession'];

  const posScore = countKeywords(allText, positiveKeywords);
  const negScore = countKeywords(allText, negativeKeywords);
  const total = posScore + negScore;

  let sentiment: BrokerSentiment = 'neutral';
  if (total > 0) {
    const ratio = posScore / total;
    if (ratio >= 0.75) sentiment = 'bullish';
    else if (ratio >= 0.55) sentiment = 'slightly_bullish';
    else if (ratio >= 0.45) sentiment = 'neutral';
    else if (ratio >= 0.25) sentiment = 'slightly_bearish';
    else sentiment = 'bearish';
  }

  // Extract positive and negative themes from narratives
  const positiveThemes: string[] = [];
  const negativeThemes: string[] = [];

  for (const n of narratives) {
    const text = `${n.marketNarrative} ${n.subMarketNarrative}`.toLowerCase();
    for (const kw of positiveKeywords) {
      if (text.includes(kw) && !positiveThemes.includes(kw)) {
        positiveThemes.push(kw);
      }
    }
    for (const kw of negativeKeywords) {
      if (text.includes(kw) && !negativeThemes.includes(kw)) {
        negativeThemes.push(kw);
      }
    }
  }

  const sentimentLabel: Record<BrokerSentiment, string> = {
    bullish: 'Bullish',
    slightly_bullish: 'Slightly Bullish',
    neutral: 'Neutral',
    slightly_bearish: 'Slightly Bearish',
    bearish: 'Bearish',
  };

  const explanation = total === 0
    ? 'Insufficient commentary to determine sentiment.'
    : `Broker Sentiment: ${sentimentLabel[sentiment]}. Across ${narratives.length} commentary excerpts, ${posScore} positive signals and ${negScore} negative signals detected.${
      positiveThemes.length > 0 ? ` Positive: ${positiveThemes.slice(0, 3).join(', ')}.` : ''
    }${negativeThemes.length > 0 ? ` Concerns: ${negativeThemes.slice(0, 3).join(', ')}.` : ''}`;

  return {
    sentiment,
    explanation,
    positiveThemes: positiveThemes.slice(0, 5),
    negativeThemes: negativeThemes.slice(0, 5),
  };
}

function extractKeyThemes(narratives: BrokerNarrative[]): string[] {
  // Collect market-level statements, filtering out property-specific content
  const themes: string[] = [];
  const seenTopics = new Set<string>();

  // Property-specific phrases that indicate this is about the deal, not the market
  const propertySignals = [
    'the property', 'the subject', 'the borrower', 'the sponsor', 'the loan',
    'this property', 'subject property', 'the collateral', 'the asset',
    'unit mix', 'rent roll', 'in-place rent', 'lease expir',
    'loan-to-value', 'debt service coverage', 'appraised value',
    'renovation', 'capital improvement', 'the building',
  ];

  // Market-level phrases that confirm this is market commentary
  const marketSignals = [
    'market', 'submarket', 'sub-market', 'msa', 'metro', 'vacancy rate',
    'absorption', 'pipeline', 'construction', 'deliveries', 'supply',
    'demand', 'rent growth', 'employment', 'population', 'migration',
    'broker', 'outlook', 'forecast', 'trend', 'inventory',
    'cap rate compression', 'transaction volume', 'investment sales',
  ];

  for (const n of narratives) {
    const text = n.marketNarrative || n.subMarketNarrative;
    if (!text) continue;

    const lower = text.toLowerCase();

    // Skip if it's clearly property-specific and has no market signals
    const hasPropertySignal = propertySignals.some((s) => lower.includes(s));
    const hasMarketSignal = marketSignals.some((s) => lower.includes(s));

    if (hasPropertySignal && !hasMarketSignal) continue;

    // Deduplicate by rough topic key
    const topicKey = lower.slice(0, 40);
    if (seenTopics.has(topicKey)) continue;
    seenTopics.add(topicKey);

    themes.push(text);
  }

  return themes.slice(0, 5);
}

function countKeywords(text: string, keywords: string[]): number {
  let count = 0;
  for (const kw of keywords) {
    let idx = 0;
    while ((idx = text.indexOf(kw, idx)) !== -1) {
      count++;
      idx += kw.length;
    }
  }
  return count;
}

function summarizeNarratives(narratives: string[], topic: string): string {
  if (narratives.length === 0) return `No ${topic} data available.`;
  if (narratives.length === 1) return narratives[0];

  // Deduplicate and combine the most distinct statements
  const unique = [...new Set(narratives)];
  if (unique.length <= 3) return unique.join(' ');

  // Take up to 3 most distinct narratives
  return unique.slice(0, 3).join(' ');
}
