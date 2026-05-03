import { ParsedDocument, DocumentSection } from '@cre/shared';
import { v4 as uuid } from 'uuid';
import { parsePdf } from './pdf-parser.service.js';
import { parseWord } from './word-parser.service.js';
import { parseExcel } from './excel-parser.service.js';

export async function parseDocument(
  buffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<ParsedDocument> {
  const fileType = getFileType(fileName, mimeType);

  let rawText = '';
  let sections: DocumentSection[] = [];
  let totalPages = 0;

  switch (fileType) {
    case 'pdf': {
      const result = await parsePdf(buffer);
      rawText = result.rawText;
      sections = result.sections;
      totalPages = result.totalPages;
      break;
    }
    case 'docx': {
      const result = await parseWord(buffer);
      rawText = result.rawText;
      sections = result.sections;
      totalPages = result.totalPages;
      break;
    }
    case 'xlsx': {
      const result = await parseExcel(buffer);
      rawText = result.rawText;
      sections = result.sections;
      totalPages = result.totalPages;
      break;
    }
    default:
      throw new Error(`Unsupported file type: ${fileName}`);
  }

  // If no sections detected, create a single section from the full text
  if (sections.length === 0) {
    sections = [
      {
        id: uuid(),
        title: 'Full Document',
        pageStart: 1,
        pageEnd: totalPages,
        content: rawText,
        sectionType: 'unknown',
      },
    ];
  }

  return {
    fileName,
    fileType,
    totalPages,
    sections,
    rawText,
    metadata: {
      fileSize: buffer.length,
    },
  };
}

function getFileType(fileName: string, mimeType: string): 'pdf' | 'docx' | 'xlsx' {
  const ext = fileName.toLowerCase().split('.').pop();
  const mime = mimeType.toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (
    ext === 'docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    return 'docx';
  if (
    ext === 'xlsx' ||
    ext === 'xls' ||
    ext === 'xlsm' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.ms-excel.sheet.macroenabled.12'
  )
    return 'xlsx';
  throw new Error(`Unsupported file format: ${ext}`);
}
