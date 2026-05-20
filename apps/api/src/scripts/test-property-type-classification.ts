// Tests for classifyPropertyType.
//
//   npm run test:property-type-classification

import { classifyPropertyType } from '../services/property-type-classification.js';

let passed = 0;
let failed = 0;
function ok(m: string): void { passed++; console.log('  ok    ' + m); }
function fail(m: string): void { failed++; console.error('  FAIL  ' + m); }
function assertEqual<T>(a: T, b: T, m: string): void {
  if (a === b) ok(m);
  else fail(m + ' (actual=' + JSON.stringify(a) + ', expected=' + JSON.stringify(b) + ')');
}

console.log('classifyPropertyType: legacy lowercase AssetTypes');
{
  const office = classifyPropertyType('office');
  assertEqual(office.normalizedAssetType, 'office',              'office normalized');
  assertEqual(office.unitOfMeasure,       'SF',                  'office unitOfMeasure=SF');
  assertEqual(office.factor,              1,                     'office factor=1');
  assertEqual(office.isRentRollProperty,  true,                  'office isRRP=true');
  assertEqual(office.detailTab,           'Property Detail - Comm', 'office detail tab=Comm');
  assertEqual(office.proFormaTab,         'Operating History and Pro Forma', 'office proForma=regular');

  const retail = classifyPropertyType('retail');
  assertEqual(retail.unitOfMeasure, 'SF', 'retail SF');
  assertEqual(retail.isRentRollProperty, true, 'retail is RRP');
  assertEqual(retail.detailTab, 'Property Detail - Comm', 'retail Comm detail');

  const industrial = classifyPropertyType('industrial');
  assertEqual(industrial.unitOfMeasure, 'SF', 'industrial SF');
  assertEqual(industrial.isRentRollProperty, true, 'industrial is RRP');

  const mf = classifyPropertyType('multifamily');
  assertEqual(mf.normalizedAssetType, 'multifamily', 'mf normalized');
  assertEqual(mf.unitOfMeasure, 'Units', 'mf Units');
  assertEqual(mf.factor, 12, 'mf factor=12');
  assertEqual(mf.isRentRollProperty, false, 'mf is NOT RRP');
  assertEqual(mf.detailTab, 'Property Detail - MF SS MHP', 'mf detail tab=MF SS MHP');

  const ss = classifyPropertyType('self_storage');
  assertEqual(ss.unitOfMeasure, 'SF', 'self_storage SF');
  assertEqual(ss.factor, 12, 'self_storage factor=12');
  assertEqual(ss.isRentRollProperty, false, 'self_storage is NOT RRP');
  assertEqual(ss.detailTab, 'Property Detail - MF SS MHP', 'self_storage MF SS MHP detail');

  const mhc = classifyPropertyType('manufactured_housing');
  assertEqual(mhc.unitOfMeasure, 'Pads', 'mhc Pads');
  assertEqual(mhc.factor, 12, 'mhc factor=12');
  assertEqual(mhc.detailTab, 'Property Detail - MF SS MHP', 'mhc MF SS MHP detail');

  const hotel = classifyPropertyType('hotel');
  assertEqual(hotel.normalizedAssetType, 'hotel', 'hotel normalized');
  assertEqual(hotel.unitOfMeasure, 'Rooms', 'hotel Rooms');
  assertEqual(hotel.factor, 365, 'hotel factor=365');
  assertEqual(hotel.isRentRollProperty, false, 'hotel is NOT RRP');
  assertEqual(hotel.detailTab, 'Property Detail - Hotel', 'hotel Hotel detail');
  assertEqual(hotel.proFormaTab, 'Hotel Op History and Pro Forma', 'hotel uses Hotel pro forma');

  const mixed = classifyPropertyType('mixed_use');
  assertEqual(mixed.unitOfMeasure, 'SF', 'mixed_use SF');
  assertEqual(mixed.isRentRollProperty, true, 'mixed_use IS RRP per Controls');
  assertEqual(mixed.detailTab, 'Property Detail - Comm', 'mixed_use Comm detail');
}

console.log('\nclassifyPropertyType: Title-case spine AssetTypes');
{
  assertEqual(classifyPropertyType('Office').normalizedAssetType,        'office',              'Office → office');
  assertEqual(classifyPropertyType('Multifamily').normalizedAssetType,   'multifamily',         'Multifamily → multifamily');
  assertEqual(classifyPropertyType('SelfStorage').normalizedAssetType,   'self_storage',        'SelfStorage → self_storage');
  assertEqual(classifyPropertyType('MHC').normalizedAssetType,           'manufactured_housing', 'MHC → manufactured_housing');
  assertEqual(classifyPropertyType('Hotel').normalizedAssetType,         'hotel',               'Hotel → hotel');
  assertEqual(classifyPropertyType('MixedUse').normalizedAssetType,      'mixed_use',           'MixedUse → mixed_use');
}

console.log('\nclassifyPropertyType: common synonyms / variations');
{
  assertEqual(classifyPropertyType('Mobile Home Park').normalizedAssetType,  'manufactured_housing', 'Mobile Home Park → MHC');
  assertEqual(classifyPropertyType('MHP').normalizedAssetType,                'manufactured_housing', 'MHP → MHC');
  assertEqual(classifyPropertyType('Self-Storage').normalizedAssetType,       'self_storage',         'Self-Storage hyphen → self_storage');
  assertEqual(classifyPropertyType('Hospitality').normalizedAssetType,        'hotel',                'Hospitality → hotel');
  assertEqual(classifyPropertyType('Mixed-Use').normalizedAssetType,          'mixed_use',            'Mixed-Use hyphen → mixed_use');
}

console.log('\nclassifyPropertyType: unknown → safe Other fallback');
{
  const other = classifyPropertyType('SpecialPurpose');
  assertEqual(other.normalizedAssetType, 'other', 'unknown asset type → other');
  assertEqual(other.unitOfMeasure,       'SF',    'fallback unitOfMeasure=SF');
  assertEqual(other.factor,              1,       'fallback factor=1');
  assertEqual(other.isRentRollProperty,  false,   'fallback is NOT RRP');
  assertEqual(other.detailTab,           'Property Detail - Comm', 'fallback Comm detail');
  assertEqual(other.proFormaTab,         'Operating History and Pro Forma', 'fallback regular pro forma');

  const empty = classifyPropertyType('');
  assertEqual(empty.normalizedAssetType, 'other', 'empty string → other');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
