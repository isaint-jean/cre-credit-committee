import mammoth from 'mammoth';
import { DocumentSection } from '@cre/shared';
import { v4 as uuid } from 'uuid';

interface ParseResult {
  rawText: string;
  sections: DocumentSection[];
  totalPages: number;
}

export async function parseWord(buffer: Buffer): Promise<ParseResult> {
  const result = await mammoth.extractRawText({ buffer });
  const rawText = result.value;

  // Approximate pages (~3000 chars per page)
  const CHARS_PER_PAGE = 3000;
  const totalPages = Math.max(1, Math.ceil(rawText.length / CHARS_PER_PAGE));

  // Also extract with HTML to detect headings
  const htmlResult = await mammoth.convertToHtml({ buffer });
  const sections = extractSectionsFromHtml(htmlResult.value, rawText, totalPages);

  return { rawText, sections, totalPages };
}

function extractSectionsFromHtml(
  html: string,
  rawText: string,
  totalPages: number
): DocumentSection[] {
  const sections: DocumentSection[] = [];
  // Match headings in the HTML
  const headingPattern = /<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi;
  const matches = [...html.matchAll(headingPattern)];

  if (matches.length === 0) {
    // Try to detect sections from the raw text using common patterns
    return detectSectionsFromText(rawText, totalPages);
  }

  // Strip HTML tags from heading text
  for (let i = 0; i < matches.length; i++) {
    const title = matches[i][1].replace(/<[^>]+>/g, '').trim();
    if (!title || title.length < 3) continue;

    const htmlBefore = html.slice(0, matches[i].index);
    const textRatio = htmlBefore.replace(/<[^>]+>/g, '').length / rawText.length;
    const pageStart = Math.max(1, Math.ceil(textRatio * totalPages));

    // Content is text until next heading
    const startPos = Math.floor(textRatio * rawText.length);
    let endPos = rawText.length;
    let pageEnd = totalPages;

    if (i + 1 < matches.length) {
      const nextHtmlBefore = html.slice(0, matches[i + 1].index);
      const nextTextRatio = nextHtmlBefore.replace(/<[^>]+>/g, '').length / rawText.length;
      endPos = Math.floor(nextTextRatio * rawText.length);
      pageEnd = Math.max(pageStart, Math.ceil(nextTextRatio * totalPages));
    }

    sections.push({
      id: uuid(),
      title,
      pageStart,
      pageEnd,
      content: rawText.slice(startPos, endPos),
      sectionType: classifySection(title),
    });
  }

  return sections;
}

function detectSectionsFromText(text: string, totalPages: number): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const lines = text.split('\n');
  const CHARS_PER_PAGE = 3000;
  let currentSection: { title: string; startChar: number; content: string } | null = null;
  let charCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Detect all-caps lines as potential section headers
    if (trimmed.length > 3 && trimmed.length < 80 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
      if (currentSection) {
        sections.push({
          id: uuid(),
          title: currentSection.title,
          pageStart: Math.max(1, Math.ceil(currentSection.startChar / CHARS_PER_PAGE)),
          pageEnd: Math.max(1, Math.ceil(charCount / CHARS_PER_PAGE)),
          content: currentSection.content,
          sectionType: classifySection(currentSection.title),
        });
      }
      currentSection = { title: trimmed, startChar: charCount, content: '' };
    }
    if (currentSection) {
      currentSection.content += trimmed + '\n';
    }
    charCount += line.length + 1;
  }

  if (currentSection) {
    sections.push({
      id: uuid(),
      title: currentSection.title,
      pageStart: Math.max(1, Math.ceil(currentSection.startChar / CHARS_PER_PAGE)),
      pageEnd: totalPages,
      content: currentSection.content,
      sectionType: classifySection(currentSection.title),
    });
  }

  return sections;
}

function classifySection(title: string): DocumentSection['sectionType'] {
  const lower = title.toLowerCase();
  if (/income|expense|financial|operating|rent|cash|noi|revenue|budget|pro.?forma|valuation|cap/.test(lower)) return 'financial';
  if (/appendix|exhibit|attachment/.test(lower)) return 'appendix';
  return 'narrative';
}
