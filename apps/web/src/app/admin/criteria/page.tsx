'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api-client';
import { ASSET_TYPES, SEVERITY_LABELS } from '@cre/shared';
import type { AssetType, FindingCategory, Severity } from '@cre/shared';
import type { CriteriaRule } from '@cre/shared';

const CATEGORIES: { value: FindingCategory; label: string }[] = [
  { value: 'leasing', label: 'Leasing Risk' },
  { value: 'cash_flow', label: 'Cash Flow Risk' },
  { value: 'expense', label: 'Expense / Capex Risk' },
  { value: 'market', label: 'Market Risk' },
  { value: 'sponsor', label: 'Sponsor Risk' },
  { value: 'loan_structure', label: 'Loan Structure Risk' },
];

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

export default function CriteriaAdminPage() {
  const [assetType, setAssetType] = useState<AssetType>('office');
  const [rules, setRules] = useState<CriteriaRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRule, setEditingRule] = useState<CriteriaRule | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    loadCriteria(assetType);
  }, [assetType]);

  const loadCriteria = async (type: AssetType) => {
    setLoading(true);
    try {
      const data = await api.getCriteria(type);
      setRules(data.criteria.rules);
    } catch {}
    setLoading(false);
  };

  const handleSave = async (rule: Partial<CriteriaRule>) => {
    try {
      if (editingRule) {
        await api.updateCriteriaRule(assetType, editingRule.id, rule);
      } else {
        await api.addCriteriaRule(assetType, rule);
      }
      await loadCriteria(assetType);
      setShowForm(false);
      setEditingRule(null);
    } catch {}
  };

  const handleDelete = async (ruleId: string) => {
    try {
      await api.deleteCriteriaRule(assetType, ruleId);
      await loadCriteria(assetType);
    } catch {}
  };

  const handleToggle = async (rule: CriteriaRule) => {
    await api.updateCriteriaRule(assetType, rule.id, { enabled: !rule.enabled });
    await loadCriteria(assetType);
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Credit Criteria Engine</h1>
          <p className="text-sm text-text-secondary">Define and manage underwriting rules per asset class</p>
        </div>
        <button
          onClick={() => { setEditingRule(null); setShowForm(true); }}
          className="btn-primary text-sm"
        >
          Add Rule
        </button>
      </div>

      {/* Asset Type Selector */}
      <div className="flex gap-2 mb-6">
        {ASSET_TYPES.map((type) => (
          <button
            key={type.value}
            onClick={() => setAssetType(type.value)}
            className={`px-4 py-2 rounded text-sm transition-colors ${
              assetType === type.value
                ? 'bg-accent text-bg-primary font-semibold'
                : 'bg-bg-secondary text-text-secondary hover:text-text-primary border border-border-primary'
            }`}
          >
            {type.label}
          </button>
        ))}
      </div>

      {/* Rule Form Modal */}
      {showForm && (
        <RuleForm
          rule={editingRule}
          assetType={assetType}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditingRule(null); }}
        />
      )}

      {/* Rules Table */}
      {loading ? (
        <div className="text-center py-12 text-text-muted">Loading criteria...</div>
      ) : (
        <div className="space-y-6">
          {CATEGORIES.map((cat) => {
            const categoryRules = rules.filter((r) => r.category === cat.value);
            if (categoryRules.length === 0) return null;
            return (
              <div key={cat.value}>
                <h3 className="text-xs font-semibold text-accent uppercase tracking-wider mb-2">
                  {cat.label} ({categoryRules.length})
                </h3>
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="table-header text-left w-6"></th>
                      <th className="table-header text-left">Rule</th>
                      <th className="table-header text-left">Condition</th>
                      <th className="table-header text-center w-20">Severity</th>
                      <th className="table-header text-center w-16">Weight</th>
                      <th className="table-header text-center w-24">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryRules.map((rule) => (
                      <tr key={rule.id} className={!rule.enabled ? 'opacity-40' : ''}>
                        <td className="table-cell">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={() => handleToggle(rule)}
                            className="rounded"
                          />
                        </td>
                        <td className="table-cell">
                          <div className="text-sm text-text-primary">{rule.name}</div>
                          <div className="text-xs text-text-muted">{rule.description}</div>
                        </td>
                        <td className="table-cell text-xs text-text-secondary">{rule.condition}</td>
                        <td className="table-cell text-center">
                          <span className={`badge badge-${rule.severity}`}>{rule.severity}</span>
                        </td>
                        <td className="table-cell text-center font-mono text-sm">{rule.weight}</td>
                        <td className="table-cell text-center">
                          <button
                            onClick={() => { setEditingRule(rule); setShowForm(true); }}
                            className="text-xs text-accent hover:text-accent-hover mr-2"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(rule.id)}
                            className="text-xs text-risk-high hover:text-risk-critical"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RuleForm({ rule, assetType, onSave, onCancel }: {
  rule: CriteriaRule | null;
  assetType: AssetType;
  onSave: (data: Partial<CriteriaRule>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(rule?.name || '');
  const [description, setDescription] = useState(rule?.description || '');
  const [category, setCategory] = useState<FindingCategory>(rule?.category || 'leasing');
  const [condition, setCondition] = useState(rule?.condition || '');
  const [severity, setSeverity] = useState<Severity>(rule?.severity || 'medium');
  const [weight, setWeight] = useState(rule?.weight || 5);

  return (
    <div className="card mb-6 border-accent/30">
      <h3 className="text-sm font-semibold text-text-primary mb-4">
        {rule ? 'Edit Rule' : 'New Rule'}
      </h3>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="text-xs text-text-secondary block mb-1">Name</label>
          <input className="input-field w-full" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-text-secondary block mb-1">Category</label>
          <select className="input-field w-full" value={category} onChange={(e) => setCategory(e.target.value as FindingCategory)}>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className="text-xs text-text-secondary block mb-1">Description</label>
          <input className="input-field w-full" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-text-secondary block mb-1">Condition</label>
          <input className="input-field w-full" value={condition} onChange={(e) => setCondition(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-text-secondary block mb-1">Severity</label>
          <select className="input-field w-full" value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-text-secondary block mb-1">Weight (1-10)</label>
          <input type="number" className="input-field w-full" min={1} max={10} value={weight} onChange={(e) => setWeight(Number(e.target.value))} />
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={() => onSave({ name, description, category, condition, severity, weight, enabled: true })} className="btn-primary text-sm">
          Save
        </button>
        <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
      </div>
    </div>
  );
}
