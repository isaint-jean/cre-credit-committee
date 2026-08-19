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
  // Data Room v2 (Piece B): bank archives. The MIME only lets multer pass the
  // .zip through — the fail-closed unpack/validation is the actual security core.
  'application/zip',
  'application/x-zip-compressed',
];

const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.xls', '.xlsm', '.csv', '.txt', '.zip'];

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

// ── Site-photos — a DEDICATED image-accepting multer instance ────────────────
// Kept SEPARATE from `upload` on purpose: the shared instance above guards every
// doc / ASR / ZIP upload (fail-closed to office/pdf/zip), and must not learn to
// accept images. Servicer site photos are their own path. We accept broadly here
// (incl. webp/heic/heif); the export layer (exportImageExtension) skips the ones
// exceljs can't embed — they're still stored, just not drawn into the workbook.
const ALLOWED_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/octet-stream', // some clients don't detect image MIME; extension is re-checked
];

const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'];

export const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB — parity with the shared instance
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase().slice(file.originalname.lastIndexOf('.'));
    const mime = file.mimetype.toLowerCase();
    // octet-stream only passes when the extension is a real image extension.
    const mimeOk = ALLOWED_IMAGE_MIMES.includes(mime) && mime !== 'application/octet-stream';
    if (mimeOk || ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported image type: ${file.mimetype} (${ext}). Accepted: JPEG, PNG, GIF, WEBP, HEIC`));
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
