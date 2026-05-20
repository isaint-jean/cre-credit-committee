import multer from 'multer';

const ALLOWED_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'text/csv',
  'application/csv',
  'application/octet-stream', // some clients don't detect MIME; we also check extension
  'text/plain',
];

const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.xls', '.xlsm', '.csv', '.txt'];

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase().slice(file.originalname.lastIndexOf('.'));
    const mime = file.mimetype.toLowerCase();
    if (ALLOWED_MIMES.some((m) => m.toLowerCase() === mime) || ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype} (${ext}). Accepted: PDF, DOCX, XLSX, XLSM`));
    }
  },
});

export const uploadDualFiles = upload.fields([
  { name: 'asr', maxCount: 1 },
  { name: 'uw', maxCount: 1 },
]);

export const uploadAnalysisFiles = upload.fields([
  { name: 'asr', maxCount: 1 },
  { name: 'seller_uw', maxCount: 1 },
  { name: 'supporting_docs', maxCount: 20 },
  { name: 'template', maxCount: 1 },
  // Batch 1A — dedicated rent-roll xlsx/xlsm slot. Source-of-truth precedence
  // (rent_roll_file > ASR rent-roll tables > Seller UW rent-roll exhibits) is
  // enforced at the producer level; this slot is the highest-priority input.
  { name: 'rent_roll', maxCount: 1 },
]);

export const uploadTripleFiles = upload.fields([
  { name: 'asr', maxCount: 1 },
  { name: 'bank_uw', maxCount: 1 },
  { name: 'template', maxCount: 1 },
]);
