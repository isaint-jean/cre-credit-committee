import { redirect } from 'next/navigation';

// /admin/registry has no UI of its own; redirect to the default tab.
// (The three real tabs live at /admin/registry/{library-snapshots,
// market-benchmarks,credit-manifestos}; this default chooses LibrarySnapshots
// because it has the build-from-approved-deals action that's often the first
// step in setting up a new environment.)
export default function RegistryIndexPage(): never {
  redirect('/admin/registry/library-snapshots');
}
