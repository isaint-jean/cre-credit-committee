/**
 * PDF text extraction + ASR section detection.
 *
 * Backed by `unpdf` (a thin wrapper over Mozilla pdf.js v5.x as a serverless
 * build). Was `pdf-parse@1.1.x` through commit 48560a9 — see issue #9 for
 * the migration rationale; in short, pdf-parse 1.1.x shipped a 2018-vintage
 * webpack-bundled pdfjs (v1.10.100) with a heap-layout sensitivity that
 * forced a lazy-import workaround in asr.adapter.ts. The unpdf migration
 * (this commit) removes both that workaround and the brittle form-feed-based
 * page-splitting heuristic — unpdf returns per-page text directly.
 *
 * Two responsibilities:
 *   1. parsePdf: bytes → { rawText, sections, totalPages }. The text layer
 *      is library-coupled (delegated to unpdf); the rest is pure.
 *   2. detectSections / classifySectionType: regex-based ASR section
 *      detection, library-agnostic. Untouched by the migration.
 */

import { extractText, getDocumentProxy } from 'unpdf';
import { DocumentSection } from '@cre/shared';
import { v4 as uuid } from 'uuid';

interface ParseResult {
  rawText: string;
  sections: DocumentSection[];
  totalPages: number;
}

export async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text: pages } = await extractText(pdf, { mergePages: false });
  const rawText = pages.join('\n');
  const sections = detectSections(pages);
  return { rawText, sections, totalPages };
}

function detectSections(pages: string[]): DocumentSection[] {
  const sections: DocumentSection[] = [];
  // Common ASR section patterns
  const sectionPatterns = [
    /^(?:SECTION\s+\d+[.:]\s*|(?:\d+\.?\d*)\s+)(.+)/im,
    /^([A-Z][A-Z\s&/]{4,})$/m,
    /^(?:EXECUTIVE\s+SUMMARY|PROPERTY\s+DESCRIPTION|MARKET\s+ANALYSIS|FINANCIAL\s+ANALYSIS|INCOME\s+APPROACH|SALES\s+COMPARISON|RENT\s+ROLL|OPERATING\s+STATEMENT|LOAN\s+SUMMARY|BORROWER|SPONSOR|ENVIRONMENTAL|APPRAISAL|VALUATION)/im,
  ];

  let currentSection: { title: string; pageStart: number; content: string } | null = null;

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageText = pages[pageIdx];
    const lines = pageText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let matchedTitle: string | null = null;
      for (const pattern of sectionPatterns) {
        const match = trimmed.match(pattern);
        if (match) {
          matchedTitle = (match[1] || match[0]).trim();
          break;
        }
      }

      if (matchedTitle && matchedTitle.length > 3 && matchedTitle.length < 80) {
        // Save previous section
        if (currentSection) {
          sections.push({
            id: uuid(),
            title: currentSection.title,
            pageStart: currentSection.pageStart,
            pageEnd: pageIdx + 1,
            content: currentSection.content,
            sectionType: classifySectionType(currentSection.title),
          });
        }
        currentSection = {
          title: matchedTitle,
          pageStart: pageIdx + 1,
          content: '',
        };
      }

      if (currentSection) {
        currentSection.content += trimmed + '\n';
      }
    }
  }

  // Save last section
  if (currentSection) {
    sections.push({
      id: uuid(),
      title: currentSection.title,
      pageStart: currentSection.pageStart,
      pageEnd: pages.length,
      content: currentSection.content,
      sectionType: classifySectionType(currentSection.title),
    });
  }

  return sections;
}

function classifySectionType(title: string): DocumentSection['sectionType'] {
  const lower = title.toLowerCase();
  const financialKeywords = [
    'income', 'expense', 'financial', 'operating', 'rent roll', 'cash flow',
    'noi', 'revenue', 'budget', 'pro forma', 'valuation', 'capitalization',
  ];
  const appendixKeywords = ['appendix', 'exhibit', 'attachment', 'addendum'];

  if (financialKeywords.some((k) => lower.includes(k))) return 'financial';
  if (appendixKeywords.some((k) => lower.includes(k))) return 'appendix';
  return 'narrative';
}
