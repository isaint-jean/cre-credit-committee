import { AssetType } from '../types/analysis';

export const ASSET_TYPES: { value: AssetType; label: string; icon: string }[] = [
  { value: 'office', label: 'Office', icon: 'Building2' },
  { value: 'multifamily', label: 'Multifamily', icon: 'Home' },
  { value: 'retail', label: 'Retail', icon: 'Store' },
  { value: 'industrial', label: 'Industrial', icon: 'Factory' },
  { value: 'hotel', label: 'Hotel', icon: 'Hotel' },
  { value: 'self_storage', label: 'Self Storage', icon: 'Warehouse' },
  { value: 'mixed_use', label: 'Mixed Use', icon: 'Building' },
  { value: 'manufactured_housing', label: 'Manufactured Housing', icon: 'Home' },
];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  office: 'Office',
  multifamily: 'Multifamily',
  retail: 'Retail',
  industrial: 'Industrial',
  hotel: 'Hotel',
  self_storage: 'Self Storage',
  mixed_use: 'Mixed Use',
  manufactured_housing: 'Manufactured Housing',
};
