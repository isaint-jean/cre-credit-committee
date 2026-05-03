import pdfParse from 'pdf-parse';
import { DocumentSection } from '@cre/shared';
import { v4 as uuid } from 'uuid';

interface ParseResult {
  rawText: string;
  sections: DocumentSection[];
  totalPages: number;
}

export async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  const data = await pdfParse(buffer);
  const totalPages = data.numpages;
  const rawText = data.text;

  // Split text by page (pdf-parse separates pages with form feeds or we estimate)
  const pages = splitIntoPages(rawText, totalPages);

  // Detect sections by looking for common ASR section headers
  const sections = detectSections(pages);

  return { rawText, sections, totalPages };
}

function splitIntoPages(text: string, totalPages: number): string[] {
  // pdf-parse often uses form feed characters between pages
  const ffSplit = text.split('\f');
  if (ffSplit.length >= totalPages) {
    return ffSplit.slice(0, totalPages);
  }

  // Fallback: split by approximate character count per page
  const charsPerPage = Math.ceil(text.length / totalPages);
  const pages: string[] = [];
  for (let i = 0; i < totalPages; i++) {
    pages.push(text.slice(i * charsPerPage, (i + 1) * charsPerPage));
  }
  return pages;
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
