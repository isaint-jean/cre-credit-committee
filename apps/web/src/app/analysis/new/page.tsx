'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useDropzone } from 'react-dropzone';
import { api } from '@/lib/api-client';
import { ASSET_TYPES } from '@cre/shared';

type TemplateSelection = '' | 'single_loan' | 'roll_up';

export default function NewAnalysisPage() {
  const router = useRouter();
  const [asrFile, setAsrFile] = useState<File | null>(null);
  const [sellerUwFile, setSellerUwFile] = useState<File | null>(null);
  const [supportingDocs, setSupportingDocs] = useState<File[]>([]);
  const [templateType, setTemplateType] = useState<TemplateSelection>('');
  const [templateAvailability, setTemplateAvailability] = useState<{ single_loan: boolean; roll_up: boolean }>({ single_loan: false, roll_up: false });
  const [templateNames, setTemplateNames] = useState<{ single_loan: string; roll_up: string }>({ single_loan: '', roll_up: '' });
  const [assetType, setAssetType] = useState<string>('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  // Check which templates are available
  useEffect(() => {
    const checkTemplates = async () => {
      try {
        const data = await api.listTemplates();
        const templates = data.templates || [];
        const activeSingleLoan = templates.find((t: any) => t.templateType === 'single_loan' && t.isActive);
        const activeRollUp = templates.find((t: any) => t.templateType === 'roll_up' && t.isActive);
        setTemplateAvailability({
          single_loan: !!activeSingleLoan,
          roll_up: !!activeRollUp,
        });
        setTemplateNames({
          single_loan: activeSingleLoan?.fileName || '',
          roll_up: activeRollUp?.fileName || '',
        });
      } catch {}
    };
    checkTemplates();
  }, []);

  // ASR dropzone
  const onDropAsr = useCallback((accepted: File[]) => {
    if (accepted.length > 0) { setAsrFile(accepted[0]); setError(''); }
  }, []);

  const { getRootProps: getAsrRootProps, getInputProps: getAsrInputProps, isDragActive: isAsrDrag } = useDropzone({
    onDrop: onDropAsr,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    },
    maxSize: 50 * 1024 * 1024,
    multiple: false,
  });

  // Seller UW dropzone
  const onDropSellerUw = useCallback((accepted: File[]) => {
    if (accepted.length > 0) { setSellerUwFile(accepted[0]); setError(''); }
  }, []);

  const { getRootProps: getSellerUwRootProps, getInputProps: getSellerUwInputProps, isDragActive: isSellerUwDrag } = useDropzone({
    onDrop: onDropSellerUw,
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
      'application/vnd.ms-excel.sheet.macroEnabled.12': ['.xlsm'],
      'application/pdf': ['.pdf'],
    },
    maxSize: 50 * 1024 * 1024,
    multiple: false,
  });

  // Supporting docs dropzone (multi-file)
  const onDropSupporting = useCallback((accepted: File[]) => {
    if (accepted.length > 0) {
      setSupportingDocs((prev) => [...prev, ...accepted]);
      setError('');
    }
  }, []);

  const { getRootProps: getSupportingRootProps, getInputProps: getSupportingInputProps, isDragActive: isSupportingDrag } = useDropzone({
    onDrop: onDropSupporting,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
      'application/vnd.ms-excel.sheet.macroEnabled.12': ['.xlsm'],
    },
    maxSize: 50 * 1024 * 1024,
    multiple: true,
  });

  const removeSupportingDoc = (index: number) => {
    setSupportingDocs((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (!asrFile || !assetType) {
      setError('Please upload an ASR document and select an asset type');
      return;
    }

    setUploading(true);
    setError('');

    try {
      const result = await api.uploadAnalysis(
        asrFile,
        assetType,
        undefined,
        sellerUwFile || undefined,
        supportingDocs.length > 0 ? supportingDocs : undefined,
        undefined,
        templateType || undefined
      );
      router.push(`/analysis/${result.id}`);
    } catch (err: any) {
      setError(err.message || 'Upload failed');
      setUploading(false);
    }
  };

  const totalFiles = (asrFile ? 1 : 0) + (sellerUwFile ? 1 : 0) + supportingDocs.length;

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <h1 className="text-2xl font-bold text-text-primary mb-2">New Analysis</h1>
      <p className="text-sm text-text-secondary mb-10">
        Upload your deal documents to begin credit analysis and generate an underwriting.
      </p>

      <div className="grid grid-cols-2 gap-6 mb-8">
        {/* Section 1: ASR */}
        <div>
          <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
            1. ASR Document <span className="text-risk-high">*</span>
          </label>
          <p className="text-xs text-text-muted mb-3">
            The Asset Summary Report from the servicer or issuer.
          </p>
          <div
            {...getAsrRootProps()}
            className={`border-2 border-dashed rounded p-8 text-center cursor-pointer transition-colors ${
              isAsrDrag
                ? 'border-accent bg-accent/5'
                : asrFile
                ? 'border-risk-positive bg-risk-positive/5'
                : 'border-border-secondary hover:border-accent/50'
            }`}
          >
            <input {...getAsrInputProps()} />
            {asrFile ? (
              <div>
                <div className="text-sm font-medium text-risk-positive mb-1">{asrFile.name}</div>
                <div className="text-xs text-text-muted">
                  {(asrFile.size / 1024 / 1024).toFixed(2)} MB — Click or drag to replace
                </div>
              </div>
            ) : (
              <div>
                <div className="text-sm text-text-secondary mb-1">
                  {isAsrDrag ? 'Drop the file here' : 'Drag & drop ASR here, or click to browse'}
                </div>
                <div className="text-xs text-text-muted">PDF, DOCX (max 50MB)</div>
              </div>
            )}
          </div>
        </div>

        {/* Section 2: Seller Underwriting */}
        <div>
          <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
            2. Seller Underwriting <span className="text-text-muted font-normal normal-case">(optional)</span>
          </label>
          <p className="text-xs text-text-muted mb-3">
            Bank or seller underwriting model — enables cross-validation against the ASR.
          </p>
          <div
            {...getSellerUwRootProps()}
            className={`border-2 border-dashed rounded p-8 text-center cursor-pointer transition-colors ${
              isSellerUwDrag
                ? 'border-accent bg-accent/5'
                : sellerUwFile
                ? 'border-risk-positive bg-risk-positive/5'
                : 'border-border-secondary hover:border-accent/50'
            }`}
          >
            <input {...getSellerUwInputProps()} />
            {sellerUwFile ? (
              <div>
                <div className="text-sm font-medium text-risk-positive mb-1">{sellerUwFile.name}</div>
                <div className="text-xs text-text-muted">
                  {(sellerUwFile.size / 1024 / 1024).toFixed(2)} MB — Click or drag to replace
                </div>
              </div>
            ) : (
              <div>
                <div className="text-sm text-text-secondary mb-1">
                  {isSellerUwDrag ? 'Drop the file here' : 'Drag & drop seller UW here, or click to browse'}
                </div>
                <div className="text-xs text-text-muted">PDF, XLSX, XLSM, XLS (max 50MB)</div>
              </div>
            )}
          </div>
        </div>

        {/* Section 3: Supporting Documents */}
        <div>
          <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
            3. Supporting Documents <span className="text-text-muted font-normal normal-case">(optional)</span>
          </label>
          <p className="text-xs text-text-muted mb-3">
            Rent rolls, leases, PSAs, and other supporting materials. Upload multiple files.
          </p>
          <div
            {...getSupportingRootProps()}
            className={`border-2 border-dashed rounded p-8 text-center cursor-pointer transition-colors ${
              isSupportingDrag
                ? 'border-accent bg-accent/5'
                : supportingDocs.length > 0
                ? 'border-risk-positive bg-risk-positive/5'
                : 'border-border-secondary hover:border-accent/50'
            }`}
          >
            <input {...getSupportingInputProps()} />
            {supportingDocs.length > 0 ? (
              <div>
                <div className="text-sm font-medium text-risk-positive mb-1">
                  {supportingDocs.length} file{supportingDocs.length > 1 ? 's' : ''} uploaded
                </div>
                <div className="text-xs text-text-muted">Click or drag to add more</div>
              </div>
            ) : (
              <div>
                <div className="text-sm text-text-secondary mb-1">
                  {isSupportingDrag ? 'Drop files here' : 'Drag & drop supporting docs, or click to browse'}
                </div>
                <div className="text-xs text-text-muted">PDF, DOCX, XLSX, XLSM (max 50MB each, up to 20 files)</div>
              </div>
            )}
          </div>
          {/* List uploaded supporting docs */}
          {supportingDocs.length > 0 && (
            <div className="mt-3 space-y-1">
              {supportingDocs.map((doc, i) => (
                <div key={i} className="flex items-center justify-between text-xs px-3 py-2 bg-bg-secondary rounded">
                  <span className="text-text-secondary truncate mr-2">{doc.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeSupportingDoc(i); }}
                    className="text-text-muted hover:text-risk-high shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Section 4: Underwriting Template */}
        <div>
          <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
            4. Underwriting Template
          </label>
          <p className="text-xs text-text-muted mb-3">
            Select the underwriting template to apply. Templates are managed in Underwriting Insights.
          </p>
          <select
            value={templateType}
            onChange={(e) => setTemplateType(e.target.value as TemplateSelection)}
            className="w-full rounded border border-border-secondary bg-bg-secondary text-text-primary text-sm px-4 py-3 focus:outline-none focus:border-accent transition-colors"
          >
            <option value="">Default Template</option>
            <option value="single_loan" disabled={!templateAvailability.single_loan}>
              Single Loan{templateAvailability.single_loan ? '' : ' (not uploaded)'}
            </option>
            <option value="roll_up" disabled={!templateAvailability.roll_up}>
              Roll-Up / Portfolio{templateAvailability.roll_up ? '' : ' (not uploaded)'}
            </option>
          </select>
          {templateType && templateAvailability[templateType] && templateNames[templateType] && (
            <div className="mt-2 text-xs text-risk-positive">
              Active template: {templateNames[templateType]}
            </div>
          )}
          {templateType && !templateAvailability[templateType] && (
            <div className="mt-2 p-3 bg-risk-high/10 border border-risk-high/30 rounded text-xs text-risk-high">
              No underwriting template found. Please upload a template in{' '}
              <a href="/admin/underwriting-insights" className="underline hover:text-risk-high/80">
                Underwriting Insights
              </a>.
            </div>
          )}
          {!templateType && !templateAvailability.single_loan && !templateAvailability.roll_up && (
            <div className="mt-2 text-xs text-text-muted">
              No templates uploaded yet.{' '}
              <a href="/admin/underwriting-insights" className="text-accent hover:text-accent-hover">
                Upload templates
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Asset Type Selection */}
      <div className="mb-8">
        <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
          5. Select Asset Type <span className="text-risk-high">*</span>
        </label>
        <div className="grid grid-cols-4 gap-3">
          {ASSET_TYPES.map((type) => (
            <button
              key={type.value}
              onClick={() => setAssetType(type.value)}
              className={`card text-center py-4 cursor-pointer transition-colors ${
                assetType === type.value
                  ? 'border-accent bg-accent/10'
                  : 'hover:border-accent/50'
              }`}
            >
              <div className="text-sm font-medium text-text-primary">{type.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-risk-high/10 border border-risk-high/30 rounded text-sm text-risk-high">
          {error}
        </div>
      )}

      {/* Summary & Submit */}
      <div className="flex items-center justify-between gap-4">
        <div className="text-xs text-text-muted">
          {totalFiles} document{totalFiles !== 1 ? 's' : ''} selected
          {assetType && <> &middot; {ASSET_TYPES.find((t) => t.value === assetType)?.label}</>}
          {templateType && <> &middot; {templateType === 'single_loan' ? 'Single Loan' : 'Roll-Up'} template</>}
        </div>
        <button
          onClick={handleSubmit}
          disabled={!asrFile || !assetType || uploading}
          className="btn-primary px-8 py-3 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {uploading ? 'Processing...' : 'Begin Analysis & Generate Underwriting'}
        </button>
      </div>
    </div>
  );
}
