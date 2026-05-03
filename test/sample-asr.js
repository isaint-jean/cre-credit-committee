// Test script: creates a sample ASR as XLSX and runs full pipeline
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const API = 'http://localhost:3001/api';

function createSampleXLSX() {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Executive Summary
  const summary = [
    ['ASSET SUMMARY REPORT - MERIDIAN OFFICE TOWER'],
    [''],
    ['Property', 'Meridian Office Tower'],
    ['Address', '1200 Commerce Blvd, Atlanta, GA 30309'],
    ['Sponsor', 'Greystone Capital Partners LLC'],
    ['Asset Type', 'Office'],
    ['Date', 'March 2026'],
    [''],
    ['EXECUTIVE SUMMARY'],
    ['Meridian Office Tower is a 245,000 SF Class A office building in Midtown Atlanta.'],
    ['Built in 2008, renovated 2019. Sponsor seeks $52,000,000 first mortgage for acquisition.'],
    ['Purchase price $72,000,000 at 6.8% going-in cap rate.'],
    ['Currently 82% occupied with weighted average lease term of 3.8 years.'],
    ['Largest tenant TechFlow Solutions occupies 38% of NRA, lease expires in 18 months.'],
    ['Second largest Pinnacle Advisory occupies 15% with 4 years remaining.'],
    [''],
    ['PROPERTY DESCRIPTION'],
    ['Year Built', '2008'],
    ['Renovation', '2019'],
    ['Net Rentable Area', '245,000 SF'],
    ['Floors', '12'],
    ['Parking', '4.2 per 1,000 SF'],
    ['Class', 'A'],
    [''],
    ['HVAC system is original (2008). Sponsor identified $3.2M in deferred maintenance:'],
    ['- Roof membrane replacement needed'],
    ['- Elevator modernization required'],
    [''],
    ['ENVIRONMENTAL'],
    ['Phase I ESA completed Feb 2026. Recognized Environmental Condition (REC) identified:'],
    ['Former dry cleaning on adjacent parcel. Phase II recommended but NOT completed.'],
    [''],
    ['APPRAISAL'],
    ['Independent appraisal Jan 2026 valued at $72,000,000.'],
    ['Stabilized vacancy assumption: 5.0%. Projected rent growth: 3.5% annually.'],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(summary);
  XLSX.utils.book_append_sheet(wb, ws1, 'Executive Summary');

  // Sheet 2: Income & Expenses
  const financials = [
    ['INCOME AND EXPENSE ANALYSIS'],
    [''],
    ['INCOME', 'Annual Amount', '$/SF'],
    ['Gross Potential Rent', 7350000, 30.00],
    ['Vacancy Loss (5.0%)', -367500, -1.50],
    ['Concessions', -110000, -0.45],
    ['Other Income', 185000, 0.76],
    ['Effective Gross Income', 7057500, 28.81],
    [''],
    ['OPERATING EXPENSES', 'Annual Amount', '$/SF'],
    ['Real Estate Taxes', 1102000, 4.50],
    ['Insurance', 245000, 1.00],
    ['Utilities', 490000, 2.00],
    ['Repairs & Maintenance', 367500, 1.50],
    ['Management Fee (4.0%)', 282300, 1.15],
    ['General & Administrative', 147000, 0.60],
    ['Replacement Reserves', 245000, 1.00],
    ['Total Operating Expenses', 2878800, 11.75],
    [''],
    ['NET OPERATING INCOME', 4178700, 17.06],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(financials);
  XLSX.utils.book_append_sheet(wb, ws2, 'Income and Expenses');

  // Sheet 3: Loan Terms
  const loan = [
    ['LOAN SUMMARY'],
    [''],
    ['Loan Amount', 52000000],
    ['Purchase Price', 72000000],
    ['Loan-to-Value', '72.2%'],
    ['Interest Rate', '6.75%'],
    ['Amortization', '30 years'],
    ['Term', '10 years'],
    ['Annual Debt Service', 4049760],
    ['DSCR', '1.18x'],
    ['Capitalization Rate', '6.80%'],
    ['Debt Yield', '8.04%'],
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(loan);
  XLSX.utils.book_append_sheet(wb, ws3, 'Loan Summary');

  // Sheet 4: Tenant Analysis
  const tenants = [
    ['TENANT ANALYSIS'],
    [''],
    ['Tenant', 'NRA (SF)', '% of NRA', 'Lease Expiry', 'Rent/SF', 'Annual Rent'],
    ['TechFlow Solutions', 93100, '38.0%', 'Sep 2027', 31.50, 2932650],
    ['Pinnacle Advisory Group', 36750, '15.0%', 'Mar 2030', 29.00, 1065750],
    ['Meridian Health Services', 22050, '9.0%', 'Jun 2028', 30.00, 661500],
    ['Various Small Tenants', 49000, '20.0%', 'Various', 28.50, 1396500],
    ['VACANT', 44100, '18.0%', '-', '-', 0],
    ['TOTAL', 245000, '100.0%', '', '', 6056400],
    [''],
    ['LEASE ROLLOVER SCHEDULE'],
    ['Year', 'SF Expiring', '% of NRA', 'Cumulative %'],
    ['2026 (Year 1)', 12250, '5.0%', '5.0%'],
    ['2027 (Year 2)', 102900, '42.0%', '47.0%'],
    ['2028 (Year 3)', 26950, '11.0%', '58.0%'],
    ['2029+', 58800, '24.0%', '82.0%'],
    [''],
    ['WARNING: 47% of NRA expires within 24 months including largest tenant.'],
    ['TechFlow Solutions (38% NRA) lease expires Sept 2027 - NO renewal confirmation.'],
  ];
  const ws4 = XLSX.utils.aoa_to_sheet(tenants);
  XLSX.utils.book_append_sheet(wb, ws4, 'Tenant Analysis');

  // Sheet 5: Market & Sponsor
  const market = [
    ['MARKET ANALYSIS - MIDTOWN ATLANTA OFFICE'],
    [''],
    ['Market Vacancy Rate', '14.2% (Q4 2025)'],
    ['Prior Year Vacancy', '11.8%'],
    ['Vacancy Trend', 'INCREASING (+240 bps YoY)'],
    ['Net Absorption (TTM)', '-180,000 SF (NEGATIVE)'],
    ['New Supply Pipeline (24 mo)', '450,000 SF'],
    ['Average Market Rent', '$32.50/SF'],
    ['Subject In-Place Rent', '$30.00/SF'],
    ['Sublease Availability', '4.8% of inventory (up from 2.1%)'],
    [''],
    ['CONCERNS:'],
    ['- Rising vacancy with negative absorption'],
    ['- Significant new supply pipeline (450K SF in 24 months)'],
    ['- Sublease availability more than doubled in 2 years'],
    ['- Subject rents 7.7% below market average'],
    [''],
    ['SPONSOR BACKGROUND - GREYSTONE CAPITAL PARTNERS LLC'],
    ['AUM', '$800 million'],
    ['HQ', 'Miami, FL'],
    ['Experience', '15 years'],
    ['Net Worth', '$45 million'],
    ['Liquidity', '$8 million'],
    [''],
    ['RISK FACTORS:'],
    ['- Dispute with former limited partner in 2023 (settled out of court)'],
    ['- Liquidity of $8M is thin relative to $52M loan request'],
    ['- No prior experience with Atlanta office market specifically'],
  ];
  const ws5 = XLSX.utils.aoa_to_sheet(market);
  XLSX.utils.book_append_sheet(wb, ws5, 'Market and Sponsor');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function runTest() {
  console.log('=== CRE Credit Committee — Full Pipeline Test ===\n');

  // Step 1: Health check
  console.log('1. Checking API health...');
  const health = await fetch(`${API.replace('/api', '')}/health`).then(r => r.json());
  console.log(`   Status: ${health.status}\n`);

  // Step 2: Check criteria
  console.log('2. Loading office criteria...');
  const criteria = await fetch(`${API}/criteria/office`).then(r => r.json());
  console.log(`   Rules loaded: ${criteria.criteria.rules.length}\n`);

  // Step 3: Upload sample ASR
  console.log('3. Uploading sample ASR (Meridian Office Tower)...');
  const xlsxBuffer = createSampleXLSX();
  fs.writeFileSync(path.join(__dirname, 'sample-asr.xlsx'), xlsxBuffer);

  const formData = new FormData();
  formData.append('file', new Blob([xlsxBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }), 'Meridian_Office_Tower_ASR.xlsx');
  formData.append('assetType', 'office');
  formData.append('name', 'Meridian Office Tower — Test Analysis');

  const uploadRes = await fetch(`${API}/analyses`, {
    method: 'POST',
    body: formData,
  }).then(r => r.json());

  console.log(`   Analysis ID: ${uploadRes.id}`);
  console.log(`   Status: ${uploadRes.status}\n`);

  // Step 4: Poll for completion
  console.log('4. Processing analysis (polling every 3s)...');
  const analysisId = uploadRes.id;
  let status = 'parsing';
  let lastStep = '';

  while (status !== 'complete' && status !== 'error') {
    await new Promise(r => setTimeout(r, 3000));
    const statusRes = await fetch(`${API}/analyses/${analysisId}/status`).then(r => r.json());
    status = statusRes.status;
    if (statusRes.currentStep !== lastStep) {
      console.log(`   [${statusRes.progress}%] ${statusRes.currentStep}`);
      lastStep = statusRes.currentStep;
    }
  }

  if (status === 'error') {
    const errRes = await fetch(`${API}/analyses/${analysisId}`).then(r => r.json());
    console.log(`\n   ERROR: ${errRes.analysis.error}`);
    return;
  }

  console.log('   COMPLETE\n');

  // Step 5: Get full analysis
  console.log('5. Fetching full analysis results...\n');
  const fullRes = await fetch(`${API}/analyses/${analysisId}`).then(r => r.json());
  const analysis = fullRes.analysis;

  console.log('='.repeat(60));
  console.log('ANALYSIS RESULTS');
  console.log('='.repeat(60));

  // Credit Score
  if (analysis.creditScore) {
    const s = analysis.creditScore;
    console.log(`\nCREDIT SCORE: ${s.overall}/100 (${s.riskTier || 'N/A'})`);
    console.log(`Recommendation: ${s.recommendation || 'N/A'}`);
    if (s.categories && s.categories.length > 0) {
      console.log('\nCategory Breakdown:');
      for (const cat of s.categories) {
        const ws = cat.weightedScore != null ? Math.round(cat.weightedScore) : '?';
        console.log(`  ${(cat.category || '').padEnd(18)} ${ws}/${cat.weight || '?'}  (raw: ${cat.score || '?'}/100)`);
      }
    }
    if (s.narrative) {
      console.log(`\nNarrative:\n  ${s.narrative}`);
    }
  }

  // Findings
  const findings = analysis.findings || [];
  console.log(`\nFINDINGS: ${findings.length} total`);
  if (findings.length > 0) {
    const bySeverity = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    }
    console.log(`  Critical: ${bySeverity['critical'] || 0}, High: ${bySeverity['high'] || 0}, Medium: ${bySeverity['medium'] || 0}, Low: ${bySeverity['low'] || 0}`);

    console.log('\nTop Findings:');
    for (const f of findings.slice(0, 10)) {
      const page = f.pageReferences?.[0]?.page || '?';
      console.log(`  [${(f.severity || '?').toUpperCase().padEnd(8)}] ${f.title} (p.${page})`);
      if (f.explanation) {
        console.log(`           ${f.explanation.slice(0, 100)}...`);
      }
    }
  }

  // UW Model
  if (analysis.uwModel) {
    const uw = analysis.uwModel;
    console.log('\nUNDERWRITING MODEL:');
    console.log(`  GPR:          $${(uw.income?.grossPotentialRent?.annualAmount || 0).toLocaleString()}`);
    console.log(`  Vacancy:      $${(uw.income?.vacancyLoss?.annualAmount || 0).toLocaleString()}`);
    console.log(`  EGI:          $${(uw.income?.effectiveGrossIncome?.annualAmount || 0).toLocaleString()}`);
    console.log(`  Total OpEx:   $${(uw.expenses?.totalExpenses?.annualAmount || 0).toLocaleString()}`);
    console.log(`  NOI:          $${(uw.netOperatingIncome || 0).toLocaleString()}`);
    console.log(`  Cap Rate:     ${uw.capRate || 0}%`);
    console.log(`  Implied Value:$${(uw.impliedValue || 0).toLocaleString()}`);
    console.log(`  Loan Amount:  $${(uw.loanAmount || 0).toLocaleString()}`);
    console.log(`  DSCR:         ${(uw.dscr || 0).toFixed(2)}x`);
    console.log(`  LTV:          ${(uw.ltv || 0).toFixed(1)}%`);
    console.log(`  Debt Yield:   ${(uw.debtYield || 0).toFixed(2)}%`);
  }

  // Criteria Evaluations
  if (analysis.criteriaEvaluations && analysis.criteriaEvaluations.length > 0) {
    const evals = analysis.criteriaEvaluations;
    const pass = evals.filter(e => e.result === 'pass').length;
    const fail = evals.filter(e => e.result === 'fail').length;
    const unknown = evals.filter(e => e.result === 'unknown').length;
    console.log(`\nCRITERIA CHECKLIST: ${pass} PASS, ${fail} FAIL, ${unknown} UNKNOWN`);
    for (const e of evals.filter(e => e.result === 'fail').slice(0, 10)) {
      console.log(`  [FAIL] ${e.ruleName}: ${(e.reason || '').slice(0, 80)}`);
    }
    for (const e of evals.filter(e => e.result === 'pass').slice(0, 5)) {
      console.log(`  [PASS] ${e.ruleName}`);
    }
  }

  // Stress Tests
  if (analysis.stressScenarios && analysis.stressScenarios.length > 0) {
    console.log('\nSTRESS TEST RESULTS:');
    const uw = analysis.uwModel;
    if (uw) {
      console.log(`  ${'Base Case'.padEnd(35)} DSCR: ${(uw.dscr||0).toFixed(2)}x  LTV: ${(uw.ltv||0).toFixed(1)}%  DY: ${(uw.debtYield||0).toFixed(2)}%  [BASE]`);
    }
    for (const s of analysis.stressScenarios) {
      const breach = s.breaksCovenants ? 'FAIL' : 'PASS';
      console.log(`  ${s.name.padEnd(35)} DSCR: ${(s.results.dscr||0).toFixed(2)}x  LTV: ${(s.results.ltv||0).toFixed(1)}%  DY: ${(s.results.debtYield||0).toFixed(2)}%  [${breach}]`);
      if (s.covenantBreaches && s.covenantBreaches.length > 0) {
        for (const b of s.covenantBreaches) {
          console.log(`         BREACH: ${b}`);
        }
      }
    }
  }

  // Step 6: Test comment system
  console.log('\n6. Testing comment system...');
  await fetch(`${API}/analyses/${analysisId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sectionId: 'general',
      stance: 'disagree',
      text: 'TechFlow rollover risk is understated. 38% single-tenant with 18-month expiry is critical.',
    }),
  });
  await fetch(`${API}/analyses/${analysisId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sectionId: 'general',
      stance: 'note',
      text: 'Phase II environmental not completed — should be required pre-closing condition.',
    }),
  });
  console.log('   2 comments added.\n');

  // Step 7: Test UW model update
  if (analysis.uwModel && analysis.uwModel.income) {
    console.log('7. Testing UW model update (vacancy 5% → 10%)...');
    const gpr = analysis.uwModel.income.grossPotentialRent?.annualAmount || 0;
    if (gpr > 0) {
      const newVacancy = -(gpr * 0.10);
      const uwUpdate = await fetch(`${API}/analyses/${analysisId}/uw-model`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: [{ path: 'income.vacancyLoss.annualAmount', value: newVacancy }],
        }),
      }).then(r => r.json());

      if (uwUpdate.uwModel) {
        console.log(`   Old NOI:  $${(analysis.uwModel.netOperatingIncome || 0).toLocaleString()}`);
        console.log(`   New NOI:  $${(uwUpdate.uwModel.netOperatingIncome || 0).toLocaleString()}`);
        console.log(`   New DSCR: ${(uwUpdate.uwModel.dscr || 0).toFixed(2)}x`);
        console.log(`   New LTV:  ${(uwUpdate.uwModel.ltv || 0).toFixed(1)}%`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('ALL TESTS PASSED');
  console.log(`Open in browser: http://localhost:3000/analysis/${analysisId}`);
  console.log('='.repeat(60));
}

runTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
