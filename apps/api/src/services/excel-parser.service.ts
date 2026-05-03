import * as XLSX from 'xlsx';
import { DocumentSection, TableData } from '@cre/shared';
import { v4 as uuid } from 'uuid';

interface ParseResult {
  rawText: string;
  sections: DocumentSection[];
  totalPages: number;
}

export async function parseExcel(buffer: Buffer): Promise<ParseResult> {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sections: DocumentSection[] = [];
  let rawText = '';

  for (let i = 0; i < workbook.SheetNames.length; i++) {
    const sheetName = workbook.SheetNames[i];
    const sheet = workbook.Sheets[sheetName];

    // Convert to array of arrays
    const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as string[][];

    // Build text representation
    const sheetText = data.map((row) => row.join('\t')).join('\n');
    rawText += `\n--- ${sheetName} ---\n${sheetText}\n`;

    // Extract table data
    const headers = data.length > 0 ? data[0].map(String) : [];
    const rows = data.slice(1).map((row) => row.map(String));

    const table: TableData = { headers, rows };

    sections.push({
      id: uuid(),
      title: sheetName,
      pageStart: i + 1,
      pageEnd: i + 1,
      content: sheetText,
      tables: [table],
      sectionType: classifySheetType(sheetName, headers),
    });
  }

  return {
    rawText,
    sections,
    totalPages: workbook.SheetNames.length,
  };
}

function classifySheetType(sheetName: string, headers: string[]): DocumentSection['sectionType'] {
  const combined = (sheetName + ' ' + headers.join(' ')).toLowerCase();
  if (/income|expense|operating|rent|cash|noi|revenue|budget|pro.?forma|financial/.test(combined)) {
    return 'financial';
  }
  return 'unknown';
}
