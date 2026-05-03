import { AssetType, FindingCategory, Severity } from '@cre/shared';
import { CriteriaRule, CriteriaRuleSet } from '@cre/shared';
import { DEFAULT_SCORING_WEIGHTS } from '@cre/shared';
import { v4 as uuid } from 'uuid';

function rule(
  assetType: AssetType,
  category: FindingCategory,
  name: string,
  description: string,
  condition: string,
  severity: Severity,
  weight: number = 5
): CriteriaRule {
  return {
    id: uuid(),
    assetType,
    category,
    name,
    description,
    condition,
    severity,
    weight,
    enabled: true,
  };
}

const officeRules: CriteriaRule[] = [
  // Structural demand and asset quality
  rule('office', 'market', 'Class B/C Asset Risk', 'Lower-tier office faces materially higher leasing, liquidity, and value risk', 'Property is Class B or C office without dominant market positioning or modern amenities', 'high', 8),
  rule('office', 'market', 'Flight-to-Quality Dynamics', 'Top-tier well-located buildings with modern amenities are favored; others face structural headwinds', 'Property lacks amenities, modern buildout, or prime location relative to competitive set', 'medium', 6),
  rule('office', 'market', 'Submarket Distress', 'Broader submarket facing structural challenges', 'Property is in a distressed office submarket (e.g., DC, Philadelphia) with elevated vacancy and negative absorption', 'high', 8),
  rule('office', 'market', 'New Supply Risk', 'Competitive supply pipeline', 'Significant new office deliveries in submarket within 24 months', 'medium', 5),
  rule('office', 'market', 'Liquidity Risk', 'Limited transaction volume even for higher-quality assets', 'Market-clearing sales comps are scarce or show declining pricing; limited buyer pool', 'high', 7),
  // Space utilization and tenant behavior
  rule('office', 'leasing', 'Work-From-Home / Space Contraction Risk', 'Actual utilization may diverge from leased occupancy', 'Tenants show signs of reduced actual utilization, work-from-home adoption, or space contraction risk', 'high', 7),
  rule('office', 'leasing', 'Shadow Vacancy / Sublease Exposure', 'Active sublease offerings represent hidden vacancy', 'Significant sublease availability in building or submarket indicating shadow vacancy', 'high', 7),
  rule('office', 'leasing', 'Lease Rollover Concentration', 'Excessive near-term lease expirations', 'More than 25% of NRA expires within 24 months', 'high', 8),
  rule('office', 'leasing', 'Single Tenant Concentration', 'Over-reliance on a single tenant', 'Top tenant occupies more than 30% of NRA', 'high', 7),
  rule('office', 'leasing', 'Below-Market Rents', 'In-place rents significantly below market', 'In-place rents more than 10% below comparable market rents', 'medium', 5),
  // Cash flow durability
  rule('office', 'cash_flow', 'NOI Overstated', 'Net operating income exceeds contractual income', 'Underwritten NOI exceeds actual contractual rental income or historical T-12 without adequate explanation', 'critical', 9),
  rule('office', 'cash_flow', 'Tenant-Level DSCR Stress', 'Cash flow fragility if top tenants vacate', 'Removing the top 2-3 tenants causes DSCR to fall below 1.0x, indicating concentrated cash flow risk', 'critical', 9),
  rule('office', 'cash_flow', 'Aggressive Vacancy Assumption', 'Underwritten vacancy below market', 'Underwritten vacancy rate is lower than current market vacancy', 'high', 7),
  rule('office', 'cash_flow', 'Future Leasing Dependency', 'NOI relies on speculative future leases', 'Stabilized NOI includes income from unsigned leases', 'high', 7),
  rule('office', 'leasing', 'Weak Leasing Velocity', 'Recent leasing activity indicates lack of competitiveness', 'Leasing velocity since 2023 is materially below submarket average, indicating property struggles to attract tenants', 'high', 7),
  rule('office', 'leasing', 'TI / Free Rent / Concession Intensity', 'Excessive concessions on recent leases erode effective rent', 'Recent leases show elevated TI packages, free rent periods, or concession intensity relative to market norms', 'medium', 6),
  // Capital reserves
  rule('office', 'expense', 'Inadequate Capital Reserves', 'Even the best office buildings need capital to defend occupancy and handle rollover', 'Property lacks adequate TI/LC and capex reserves for upcoming lease expirations and tenant improvements; being properly reserved is crucial', 'high', 8),
  rule('office', 'expense', 'Below-Market Expense Assumptions', 'Operating expenses understated', 'Underwritten expenses per sqft significantly below market comps', 'medium', 5),
  rule('office', 'expense', 'Deferred Maintenance', 'Significant capital needs not reserved', 'Property has identified deferred maintenance or capital needs without adequate reserves', 'high', 6),
  // Sponsor
  rule('office', 'sponsor', 'Sponsor Litigation / Bankruptcies / Foreclosures', 'Pending legal actions or adverse history', 'Sponsor has material pending litigation, bankruptcies, foreclosures, or negative press', 'high', 7),
  rule('office', 'sponsor', 'Portfolio Correlation Risk', 'Sponsor over-concentrated in similar assets', 'Sponsor has correlated exposure across portfolio that amplifies default risk', 'medium', 5),
  // Loan structure
  rule('office', 'loan_structure', 'High LTV', 'Loan-to-value exceeds prudent levels', 'LTV exceeds 70%', 'high', 8),
  rule('office', 'loan_structure', 'Low DSCR', 'Debt service coverage below threshold', 'DSCR below 1.25x on in-place cash flow', 'high', 8),
  rule('office', 'loan_structure', 'Low Debt Yield', 'Insufficient debt yield', 'Debt yield below 8% indicating aggressive sizing relative to income', 'high', 7),
  rule('office', 'loan_structure', 'Refinance Risk', 'Maturity default exposure', 'Projected refinance LTV exceeds 75% at loan maturity under stressed cap rates', 'high', 7),
  rule('office', 'loan_structure', 'Cash-Out Refinance', 'Heightened risk from equity extraction', 'Loan proceeds include material cash-out to borrower; evaluate cost basis and total invested capital', 'high', 7),
  rule('office', 'loan_structure', 'Interest-Only Risk', 'No amortization during loan term', 'Full-term interest-only with no amortization', 'medium', 5),
];

const multifamilyRules: CriteriaRule[] = [
  // Operating history and vintage risk
  rule('multifamily', 'cash_flow', 'Insufficient Operating History', 'Assets 5+ years old should demonstrate ~3 years of stable operations', 'Property is 5+ years old but lacks approximately 3 years of stable, demonstrated operating history', 'high', 8),
  rule('multifamily', 'cash_flow', 'Renovation-Driven NOI Skepticism', 'Older vintage properties with NOI growth from renovations are viewed skeptically', 'NOI growth is primarily renovation-driven on an older vintage property; upgrading Class C to durable Class B is difficult and often unsustainable', 'high', 7),
  rule('multifamily', 'cash_flow', 'NOI Overstated', 'Net operating income exceeds contractual income', 'Underwritten NOI includes pro forma income assumptions or exceeds historical performance without explanation', 'high', 8),
  rule('multifamily', 'cash_flow', 'Low Vacancy Assumption', 'Underwritten vacancy unrealistic', 'Underwritten vacancy below 5% or below market vacancy', 'high', 7),
  // Leasing and rent verification
  rule('multifamily', 'leasing', 'Aggressive Rent Growth', 'Unrealistic rent growth projections', 'Projected rent growth exceeds 3% annually or market trend', 'high', 7),
  rule('multifamily', 'leasing', 'Concessions / Bad Debt / Collections Risk', 'Newer assets and lease-ups require extra scrutiny on effective income', 'Concessions, bad debt, or collection issues are elevated or inadequately analyzed, particularly where operating history is limited', 'high', 7),
  rule('multifamily', 'leasing', 'Rent Comparability Not Verified', 'Rents must be verified against competing assets and their concession offerings', 'Rents have not been verified by checking competing assets and knowing their concession offerings', 'high', 7),
  rule('multifamily', 'leasing', 'Student Housing Classified as Standard Multifamily', 'Student housing is NOT down-the-fairway multifamily', 'Property is student housing but being underwritten as standard multifamily; student housing requires specialized underwriting criteria', 'high', 8),
  // Capital intensity and physical risk
  rule('multifamily', 'expense', 'Historical and Forward Capex Scrutiny', 'Scrutinize capex particularly roofs and major systems', 'Historical and forward-looking capex inadequately analyzed, particularly roofs, major building systems, and deferred maintenance', 'high', 7),
  rule('multifamily', 'expense', 'Tax Assessment Risk', 'Potential reassessment upon sale', 'Real estate taxes and expense comparability not adjusted for post-acquisition reassessment', 'medium', 5),
  rule('multifamily', 'expense', 'Insurance Cost Exposure', 'Rising insurance not adequately underwritten', 'Insurance costs not stress-tested for market increases', 'medium', 5),
  rule('multifamily', 'expense', 'Certificate of Occupancy Not Confirmed', 'CO verification required', 'Certificates of occupancy have not been confirmed for the property or recent renovations', 'medium', 6),
  // Neighborhood quality and safety
  rule('multifamily', 'market', 'Crime Risk', 'Crime is a first-order underwriting concern for multifamily', 'Property is in an area with elevated crime rates or has documented crime/safety issues; review third-party tenant review sites for substantive resident issues', 'critical', 9),
  rule('multifamily', 'market', 'Tenant Quality / Resident Issues', 'Third-party reviews reveal substantive concerns', 'Third-party websites show resident complaints about crime, deferred maintenance, pests, or management quality', 'high', 7),
  rule('multifamily', 'market', 'New Supply Risk', 'New construction competition', 'Significant multifamily deliveries in submarket — always assess new supply', 'high', 6),
  // Regulatory and supply risk
  rule('multifamily', 'market', 'Rent Control / Stabilization / Voucher Exposure', 'Regulatory rent limitations and subsidy dependency', 'Property is exposed to rent control, rent stabilization, housing vouchers, or subsidies that constrain income growth or create regulatory risk', 'high', 7),
  // Sponsor and capital structure
  rule('multifamily', 'sponsor', 'Highly Syndicated Equity Structure', 'Avoid highly syndicated equity structures', 'Equity structure is highly syndicated across multiple passive investors, creating decision-making and capital call risk', 'high', 7),
  rule('multifamily', 'sponsor', 'Sponsor Portfolio Concentration', 'Correlated exposure across sponsor portfolio', 'Sponsor has concentrated or correlated multifamily exposure that amplifies systemic risk', 'medium', 5),
  rule('multifamily', 'sponsor', 'Sponsor Litigation / Adverse History', 'Pending legal actions or adverse history', 'Sponsor has material litigation, bankruptcies, foreclosures, or negative press', 'high', 7),
  // Loan structure
  rule('multifamily', 'loan_structure', 'High LTV', 'Loan-to-value exceeds prudent levels', 'LTV exceeds 75%', 'high', 8),
  rule('multifamily', 'loan_structure', 'Low DSCR', 'Debt service coverage below threshold', 'DSCR below 1.20x on in-place cash flow', 'high', 8),
  rule('multifamily', 'loan_structure', 'Refinance Risk', 'Maturity default exposure', 'Projected refinance LTV exceeds 80% at loan maturity under stressed cap rates', 'high', 7),
  rule('multifamily', 'loan_structure', 'Cash-Out Refinance', 'Heightened risk from equity extraction', 'Loan proceeds include material cash-out; evaluate cost basis, acquisition date, and total invested capital', 'high', 7),
];

const retailRules: CriteriaRule[] = [
  // Tenant sales and occupancy costs — best indicator of center health
  rule('retail', 'cash_flow', 'Tenant Sales Performance', 'Tenant sales PSF are the best indicator of a center\'s health', 'In-line tenant sales below ~$500 PSF for malls or below market benchmarks for the retail format', 'high', 8),
  rule('retail', 'cash_flow', 'Occupancy Cost Ratio', 'High occupancy costs signal tenant vulnerability', 'Tenant occupancy cost ratios exceed low-teens percentage threshold, indicating rent burden risk', 'high', 8),
  rule('retail', 'cash_flow', 'Cumulative Owner Cash Flow', 'Total borrower cash flow over loan term must be evaluated', 'Cumulative owner cash flow over the loan term has not been calculated or is negative/marginal', 'high', 7),
  rule('retail', 'cash_flow', 'NOI Overstated', 'Net operating income inflated', 'Underwritten NOI includes speculative assumptions or exceeds historical performance without explanation', 'high', 8),
  rule('retail', 'cash_flow', 'Percentage Rent Dependency', 'Income relies on sales-based rent', 'More than 15% of income from percentage rent', 'medium', 5),
  // Retail format bifurcation
  rule('retail', 'market', 'Retail Format Risk', 'Power centers and grocery-anchored centers are inherently different from malls, lifestyle, and outlet centers', 'Property is a regional mall, lifestyle center, or outlet center — requires differentiated and more conservative underwriting', 'medium', 6),
  rule('retail', 'market', 'B-Quality Mall Risk', 'B-quality malls are difficult to finance absent dominant market positioning', 'Mall lacks dominant market positioning, competitive in-line sales, or strong anchor lineup', 'critical', 9),
  rule('retail', 'loan_structure', 'Mall Debt Yield', 'Mall debt yields must reflect format risk', 'Mall debt yield below mid-teens; fortress Class A malls may support ~10-11% but B malls require higher', 'high', 8),
  // Tenant and lease structure risk
  rule('retail', 'leasing', 'Tenant Bankruptcy Risk', 'Tenants in vulnerable categories', 'Major tenants in high-risk categories (e.g., movie theaters) with elevated bankruptcy probability', 'high', 8),
  rule('retail', 'leasing', 'Alternative Tenancy Re-Tenanting Risk', 'Non-traditional uses with limited replacement depth', 'Significant income from alternative tenancy with limited re-tenanting depth (trampoline parks, etc.)', 'medium', 6),
  rule('retail', 'leasing', 'Co-Tenancy and Sales Kick-Out Rights', 'Anchor departure triggers or tenant exits', 'Co-tenancy provisions or sales kick-out rights allow rent reduction or termination — must be analyzed in detail', 'high', 7),
  rule('retail', 'leasing', 'Tenant Credit Quality', 'Weak tenant creditworthiness', 'Major tenants have below investment-grade credit ratings', 'high', 8),
  rule('retail', 'leasing', 'Inline Tenant Fragility', 'Small tenant default risk', 'More than 30% of income from tenants with less than 3 years remaining', 'medium', 5),
  // Physical and demographic fundamentals
  rule('retail', 'market', 'Shrinking Store Prototypes / Big-Box Re-Tenanting Risk', 'Evolving retail formats create backfill risk', 'Property has large-format spaces at risk of vacancy due to shrinking prototype store sizes or big-box downsizing trends', 'medium', 6),
  rule('retail', 'market', 'Demographics and Population Growth', 'Foundational demand drivers', 'Trade area shows declining population, household income, or weak demographic trends', 'high', 7),
  rule('retail', 'expense', 'CAM Recovery Shortfall', 'Expense recovery below cost', 'CAM recovery ratio below 85%', 'medium', 5),
  // Sponsorship
  rule('retail', 'sponsor', 'Sponsor Quality and Asset Give-Backs', 'Sponsor historical behavior is critical, particularly on malls', 'Sponsor has history of asset give-backs, deed-in-lieu, or material litigation/bankruptcies/foreclosures', 'critical', 9),
  // Loan structure
  rule('retail', 'loan_structure', 'High LTV', 'Excessive leverage', 'LTV exceeds 65%', 'high', 8),
  rule('retail', 'loan_structure', 'Low DSCR', 'Insufficient coverage', 'DSCR below 1.30x', 'high', 8),
  rule('retail', 'loan_structure', 'Cash-Out Refinance', 'Heightened risk from equity extraction', 'Loan proceeds include material cash-out to borrower', 'high', 7),
];

const industrialRules: CriteriaRule[] = [
  // Functional obsolescence
  rule('industrial', 'market', 'Older / Specialized Manufacturing Backfill Risk', 'Older and highly specialized manufacturing assets pose elevated backfill risk', 'Property is an older or highly specialized manufacturing facility with limited alternative-use tenants and elevated re-tenanting risk', 'high', 8),
  rule('industrial', 'leasing', 'Functional Obsolescence', 'Physical specifications below current standards', 'Clear height, loading, power, or building configuration below current market standards for the target tenant profile', 'high', 7),
  rule('industrial', 'market', 'Specialized Use / Cold-Storage Risk', 'Highly specialized uses like cold-storage are an underwriting challenge', 'Property is a highly specialized use (cold-storage, data center, etc.) requiring specialized underwriting and narrower buyer/tenant universe', 'high', 7),
  // Tenant and structure risk
  rule('industrial', 'leasing', 'Sale-Leaseback with PE-Owned Non-Credit Tenant', 'Sale-leasebacks with PE-owned non-credit tenants viewed negatively', 'Property is a sale-leaseback with a private equity-owned, non-investment-grade tenant — viewed negatively due to leveraged tenant balance sheet', 'high', 8),
  rule('industrial', 'leasing', 'Tenant Credit Quality', 'Tenant credit is critical where lease term is primary support', 'Tenant lacks investment-grade credit rating and lease term is the primary cash flow support for the loan', 'high', 8),
  rule('industrial', 'leasing', 'Tenant Concentration', 'Single-tenant dependency', 'Single tenant represents more than 50% of income', 'high', 8),
  rule('industrial', 'leasing', 'Lease Duration Risk', 'Short remaining lease term', 'Weighted average lease term below 5 years', 'medium', 5),
  // Preferred asset profile
  rule('industrial', 'market', 'Asset Fungibility', 'Fungible, newer-build industrial with standard specs is favored', 'Property is not a fungible, newer-build asset with standard specifications; non-standard assets face elevated re-leasing and disposition risk', 'medium', 6),
  rule('industrial', 'market', 'Market Diversification', 'Dynamic markets with diversified demand are preferred', 'Property is in a market with concentrated demand drivers or limited tenant depth', 'medium', 5),
  // Cash flow
  rule('industrial', 'cash_flow', 'NOI Overstated', 'Net operating income inflated', 'Underwritten NOI includes speculative assumptions or exceeds historical performance', 'high', 8),
  // Environmental
  rule('industrial', 'expense', 'Environmental Risk', 'Contamination or remediation exposure', 'Environmental concerns identified or Phase I recommendations pending', 'high', 7),
  // Sponsor
  rule('industrial', 'sponsor', 'Sponsor Track Record', 'Limited industrial experience', 'Sponsor lacks comparable industrial asset management experience', 'medium', 5),
  rule('industrial', 'sponsor', 'Sponsor Litigation / Adverse History', 'Pending legal actions or adverse history', 'Sponsor has material litigation, bankruptcies, foreclosures, or negative press', 'high', 7),
  // Loan structure
  rule('industrial', 'loan_structure', 'High LTV', 'Excessive leverage', 'LTV exceeds 65%', 'high', 8),
  rule('industrial', 'loan_structure', 'Low DSCR', 'Insufficient coverage', 'DSCR below 1.25x', 'high', 8),
  rule('industrial', 'loan_structure', 'Cash-Out Refinance', 'Heightened risk from equity extraction', 'Loan proceeds include material cash-out to borrower', 'high', 7),
];

const hotelRules: CriteriaRule[] = [
  // Supply and demand dynamics
  rule('hotel', 'market', 'New Supply Risk', 'New supply is a primary risk for hotels and must be evaluated in detail', 'Significant new hotel rooms under construction or planned in competitive set; new supply is the primary risk', 'critical', 9),
  rule('hotel', 'market', 'Demand Generator Concentration', 'Concentrated demand sources', 'Heavy reliance on single demand generator or narrow demand base (single corporate account, event-driven, seasonal)', 'medium', 6),
  // Capital intensity and franchise risk
  rule('hotel', 'expense', 'Franchise / Flag Expiration Risk', 'Franchise or flag expiration dates are required diligence items', 'Franchise or flag agreement expiration date is near-term or not disclosed; expiration creates material re-branding/value risk', 'high', 8),
  rule('hotel', 'expense', 'PIP Exposure and Renovation Cycle', 'Most brands require renovations on ~7-year cycles; PIPs range ~$15k/key to ~$40-50k/key for full-service', 'Required brand PIP not fully funded or reserved; typical PIPs range from ~$15k/key (limited-service) to ~$40-50k/key (full-service)', 'high', 8),
  rule('hotel', 'expense', 'FF&E Reserve Adequacy', 'Insufficient furniture/fixture reserves', 'FF&E reserve below 4% of gross revenue', 'medium', 5),
  // Asset age and format risk
  rule('hotel', 'market', 'Older Hotel Franchise Push-Out Risk', 'Older hotels at risk of being pushed out of franchise systems', 'Property is an older-generation hotel (e.g., first-gen Hampton Inns from 1990s) at risk of losing franchise affiliation or requiring disproportionate renovation investment', 'high', 7),
  rule('hotel', 'market', 'Older Full-Service CBD Hotel Risk', 'Older full-service CBD hotels are particularly challenging', 'Property is an older full-service hotel in a CBD location facing structural challenges from changing travel patterns and capital intensity', 'high', 7),
  // Cash flow volatility
  rule('hotel', 'cash_flow', 'NOI Overstated', 'Net operating income inflated', 'Underwritten NOI exceeds trailing 12-month performance without adequate justification', 'high', 8),
  rule('hotel', 'cash_flow', 'RevPAR Volatility', 'Revenue per available room instability', 'RevPAR has declined or shown high volatility over trailing 12 months', 'high', 8),
  rule('hotel', 'cash_flow', 'Seasonality and Demand Mix Risk', 'Concentrated revenue periods and narrow demand segments', 'More than 40% of revenue generated in 3 months or fewer, or demand mix heavily concentrated in one segment', 'medium', 6),
  rule('hotel', 'cash_flow', 'Group and Contract Business Concentration', 'Over-reliance on group or contracted business', 'Significant portion of revenue depends on group bookings or contract business that may not renew', 'medium', 6),
  // Leverage assessment
  rule('hotel', 'loan_structure', 'High LTV', 'Excessive leverage', 'LTV exceeds 60%', 'high', 8),
  rule('hotel', 'loan_structure', 'Low DSCR', 'Insufficient coverage', 'DSCR below 1.40x', 'high', 8),
  rule('hotel', 'loan_structure', 'Debt Yield and Revenue Multiple Assessment', 'Assess leverage using both debt yield and multiples of room revenue', 'Debt yield or loan amount as a multiple of room revenue indicates aggressive sizing relative to the asset\'s revenue-generating capacity', 'high', 7),
  rule('hotel', 'loan_structure', 'Cyclical Downturn Risk', 'Recession vulnerability', 'No cash sweep or reserve structure for downturn protection', 'high', 7),
  // Sponsor
  rule('hotel', 'sponsor', 'Management Quality', 'Operator concerns', 'Management company lacks strong brand affiliation or demonstrated hotel operating track record', 'high', 7),
  rule('hotel', 'sponsor', 'Sponsor Litigation / Adverse History', 'Pending legal actions or adverse history', 'Sponsor has material litigation, bankruptcies, foreclosures, or negative press', 'high', 7),
];

const selfStorageRules: CriteriaRule[] = [
  // Operating stability
  rule('self_storage', 'cash_flow', 'Stable Historical Performance Required', 'Stable historical performance is essential for self-storage', 'Property lacks demonstrated stable historical operating performance; self-storage requires proven, seasoned cash flow', 'high', 8),
  rule('self_storage', 'cash_flow', 'NOI Overstated', 'Net operating income inflated', 'Underwritten NOI includes pro forma rate increases or speculative occupancy gains beyond historical performance', 'high', 8),
  rule('self_storage', 'leasing', 'Occupancy Volatility', 'Month-to-month tenant base creates instability', 'Physical occupancy has fluctuated more than 10% over trailing 12 months', 'medium', 6),
  rule('self_storage', 'leasing', 'Rate Optimization Risk', 'Aggressive existing customer rate increases', 'ECRI program pushes in-place rates more than 15% above street rates', 'high', 7),
  rule('self_storage', 'cash_flow', 'Ancillary Income Dependency', 'Excessive reliance on non-rental income', 'More than 15% of EGI from ancillary sources (insurance, retail, truck rental)', 'medium', 5),
  // Supply discipline
  rule('self_storage', 'market', 'Per-Capita Supply Oversaturation', 'Evaluate supply at the trade-area level using per-capita metrics', 'Trade area self-storage supply exceeds ~7 SF per capita; materially higher levels warrant caution', 'high', 8),
  rule('self_storage', 'market', 'New Supply Pipeline', 'Competitive new deliveries', 'New self-storage supply within trade area exceeds 5% of existing inventory', 'high', 8),
  rule('self_storage', 'market', 'Population Density Concern', 'Insufficient demand base', 'Trade area population within 3-mile radius below 50,000', 'medium', 5),
  // Expenses
  rule('self_storage', 'expense', 'Property Tax Reassessment', 'Potential post-acquisition tax increase', 'Real estate taxes not adjusted for reassessment upon sale', 'medium', 5),
  rule('self_storage', 'expense', 'Management Fee Underwritten Below Market', 'Below-market management fee', 'Management fee underwritten below 6% of EGI', 'medium', 5),
  // Sponsor
  rule('self_storage', 'sponsor', 'Operator Experience', 'Limited self-storage track record', 'Sponsor or manager lacks demonstrated self-storage operating experience', 'medium', 5),
  // Credit standards
  rule('self_storage', 'loan_structure', 'High LTV', 'Excessive leverage', 'LTV exceeds 70%', 'high', 8),
  rule('self_storage', 'loan_structure', 'Low DSCR', 'Minimum DSCR of approximately 1.30x', 'DSCR below 1.30x; target minimum DSCR of approximately 1.30x for self-storage', 'high', 8),
  rule('self_storage', 'loan_structure', 'Low Debt Yield', 'Debt yield of 8% is the floor, and only in good markets with history', 'Debt yield below 8%; 8% is as low as you should go, and only in good markets with established operating history', 'high', 8),
];

const mixedUseRules: CriteriaRule[] = [
  rule('mixed_use', 'leasing', 'Component Dependency', 'Single component drives income', 'More than 60% of NOI derived from a single use type (retail, office, or residential)', 'high', 7),
  rule('mixed_use', 'leasing', 'Retail Vacancy Drag', 'Ground-floor retail weakness', 'Retail component vacancy exceeds 15%', 'high', 7),
  rule('mixed_use', 'leasing', 'Lease Rollover Concentration', 'Near-term expirations across components', 'More than 25% of commercial NRA expires within 24 months', 'high', 7),
  rule('mixed_use', 'cash_flow', 'NOI Overstated', 'Net operating income inflated', 'Underwritten NOI includes speculative assumptions across components', 'high', 8),
  rule('mixed_use', 'cash_flow', 'Cross-Subsidy Risk', 'Weak component subsidized by strong', 'One component operates below breakeven and is subsidized by other components', 'medium', 6),
  rule('mixed_use', 'expense', 'Allocation Methodology Risk', 'Unclear expense allocation between uses', 'Expense allocation between components is not clearly documented or market-supported', 'medium', 5),
  rule('mixed_use', 'expense', 'Deferred Maintenance', 'Capital needs across multiple components', 'Identified deferred maintenance or capital needs without adequate reserves', 'high', 6),
  rule('mixed_use', 'market', 'Zoning and Entitlement Risk', 'Complex regulatory environment', 'Property relies on special zoning or entitlements that constrain alternative use', 'medium', 5),
  rule('mixed_use', 'market', 'Location Mismatch', 'Components misaligned with submarket', 'One or more use types are not well-suited for the immediate submarket', 'medium', 5),
  rule('mixed_use', 'sponsor', 'Multi-Asset Experience', 'Limited mixed-use expertise', 'Sponsor lacks experience managing properties with multiple use types', 'medium', 5),
  rule('mixed_use', 'loan_structure', 'High LTV', 'Excessive leverage', 'LTV exceeds 65%', 'high', 8),
  rule('mixed_use', 'loan_structure', 'Low DSCR', 'Insufficient coverage', 'DSCR below 1.25x', 'high', 8),
  rule('mixed_use', 'loan_structure', 'Valuation Complexity', 'Difficult to value individual components', 'No reliable comparable sales for mixed-use properties in submarket', 'medium', 5),
];

const manufacturedHousingRules: CriteriaRule[] = [
  // Physical infrastructure
  rule('manufactured_housing', 'expense', 'Property Age and Condition', 'Property age and condition are critical for mobile home parks', 'Property age and physical condition have not been thoroughly assessed; older parks require detailed infrastructure evaluation', 'high', 8),
  rule('manufactured_housing', 'expense', 'Utility Structure Risk', 'Fully understand utility structure including municipal vs private systems', 'Utility structure not fully documented — must understand whether systems are municipal or private, including water, sewer, and electric', 'high', 7),
  rule('manufactured_housing', 'expense', 'Private Wastewater / Lift Station Capex Risk', 'Private wastewater treatment plants and lift stations pose significant capex risk', 'Property has private wastewater treatment plant or lift stations requiring significant ongoing capital investment and regulatory compliance', 'critical', 9),
  rule('manufactured_housing', 'expense', 'Infrastructure Age', 'Aging utility systems and roads', 'Community infrastructure (water, sewer, roads, electrical) requires significant capital investment', 'high', 7),
  // Park-owned homes
  rule('manufactured_housing', 'leasing', 'Park-Owned Home Vacancy and Capex Exposure', 'Analyze the number of park-owned homes and associated vacancy and capex', 'Significant number of park-owned homes creating vacancy risk and ongoing capex/replacement burden; understand regulatory and eviction dynamics', 'high', 7),
  rule('manufactured_housing', 'leasing', 'Pad Rent Growth Assumptions', 'Unrealistic rent increase projections', 'Projected pad rent growth exceeds 5% annually or market trend', 'high', 7),
  rule('manufactured_housing', 'leasing', 'Occupancy Risk', 'Difficulty backfilling vacant pads', 'Vacant pads have been unoccupied for more than 12 months', 'medium', 5),
  // Cash flow
  rule('manufactured_housing', 'cash_flow', 'NOI Overstated', 'Net operating income inflated', 'Underwritten NOI includes income from unoccupied pads or speculative rent increases beyond historical performance', 'high', 8),
  rule('manufactured_housing', 'cash_flow', 'Utility Expense Passthrough', 'Incomplete expense recovery', 'Utility costs not fully passed through to tenants via sub-metering or RUBS', 'medium', 5),
  // Regulatory and exit considerations
  rule('manufactured_housing', 'market', 'Environmental Risk — Older Plumbing / Sewage', 'Environment risk is a core concern, specifically with older plumbing and sewage systems', 'Property has older plumbing or sewage systems creating environmental contamination risk; Phase I/II environmental review is critical', 'critical', 9),
  rule('manufactured_housing', 'market', 'Regulatory and Eviction Risk', 'Rent control, tenant protection, or eviction restrictions', 'Property located in jurisdiction with MH-specific rent control, tenant protection statutes, or restrictive eviction dynamics', 'high', 7),
  rule('manufactured_housing', 'market', 'Exit Liquidity and Buyer Universe', 'Exit liquidity and buyer universe under stress must be evaluated', 'Limited buyer universe for manufactured housing communities, particularly under stress scenarios; disposition risk is material', 'high', 7),
  rule('manufactured_housing', 'market', 'Declining Demographics', 'Weakening demand base', 'Trade area shows declining population or household income trends', 'medium', 5),
  // Sponsor
  rule('manufactured_housing', 'sponsor', 'MH Operating Experience', 'Limited manufactured housing expertise', 'Sponsor lacks demonstrated experience operating manufactured housing communities', 'medium', 5),
  // Loan structure
  rule('manufactured_housing', 'loan_structure', 'High LTV', 'Excessive leverage', 'LTV exceeds 70%', 'high', 8),
  rule('manufactured_housing', 'loan_structure', 'Low DSCR', 'Insufficient coverage', 'DSCR below 1.25x', 'high', 8),
];

const RULES_MAP: Record<AssetType, CriteriaRule[]> = {
  office: officeRules,
  multifamily: multifamilyRules,
  retail: retailRules,
  industrial: industrialRules,
  hotel: hotelRules,
  self_storage: selfStorageRules,
  mixed_use: mixedUseRules,
  manufactured_housing: manufacturedHousingRules,
};

export function getDefaultCriteria(assetType: AssetType): CriteriaRuleSet {
  return {
    assetType,
    rules: RULES_MAP[assetType] || [],
    scoringWeights: { ...DEFAULT_SCORING_WEIGHTS },
  };
}
