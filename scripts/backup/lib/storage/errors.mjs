// Thrown by every storage adapter when a create-only write targets a name that
// already exists. Backups never overwrite or delete objects (the CI identity has
// no delete permission), so callers decide whether an existing object is fine.
export class ObjectExistsError extends Error {
  constructor(key, options) {
    super(`Object already exists: ${key}`, options)
    this.name = 'ObjectExistsError'
    this.code = 'OBJECT_EXISTS'
    this.key = key
  }
}

// Object keys are always relative, slash-separated, and free of "." / ".."
// segments so that the local adapter can never write outside its root.
export function assertValidKey(key) {
  if (typeof key !== 'string' || key === '') throw new TypeError('Object key must be a non-empty string')
  if (key.startsWith('/') || key.endsWith('/')) throw new Error(`Invalid object key: ${key}`)
  if (key.includes('\\') || key.includes('\0')) throw new Error(`Invalid object key: ${key}`)
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || segment.startsWith('.partial-')) {
      throw new Error(`Invalid object key: ${key}`)
    }
  }
}
