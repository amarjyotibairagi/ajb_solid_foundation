/**
 * Background operations run by the provisioning worker. Step lists are shared
 * by the services that enqueue them (platform and tenant BFFs) and the worker
 * that executes them, so progress shown in the UI matches what runs.
 */
export type OperationType = 'migrate' | 'relocate_database' | 'relocate_storage'

export const operationSteps: Record<OperationType, ReadonlyArray<{ code: string; message: string }>> = {
  migrate: [
    { code: 'MIGRATE_VALIDATE', message: 'Checking tenant state' },
    { code: 'MIGRATE_APPLY', message: 'Applying schema upgrades and access rules' },
    { code: 'MIGRATE_FINALIZE', message: 'Recording the new schema version' },
  ],
  relocate_database: [
    { code: 'RELOC_VALIDATE', message: 'Checking the target and entering maintenance' },
    { code: 'RELOC_PREPARE_TARGET', message: 'Preparing the target schema' },
    { code: 'RELOC_COPY_DATA', message: 'Copying and verifying tenant data' },
    { code: 'RELOC_SWITCH', message: 'Switching the tenant to the new database' },
    { code: 'RELOC_PURGE_SOURCE', message: 'Removing the previous VDS copy' },
    { code: 'RELOC_EXIT_MAINTENANCE', message: 'Leaving maintenance' },
  ],
  relocate_storage: [
    { code: 'STORAGE_VALIDATE', message: 'Checking storage backends' },
    { code: 'STORAGE_COPY_OBJECTS', message: 'Moving files to the active storage' },
    { code: 'STORAGE_FINALIZE', message: 'Finishing' },
  ],
}

export const objectKeyFor = (objectId: string) => `objects/${objectId}`
