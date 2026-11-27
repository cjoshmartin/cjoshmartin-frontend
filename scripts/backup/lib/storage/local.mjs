import {randomBytes} from 'node:crypto'
import {constants as fsConstants} from 'node:fs'
import {copyFile, link, mkdir, open, readdir, readFile, stat, unlink, writeFile} from 'node:fs/promises'
import path from 'node:path'

import {ObjectExistsError, assertValidKey} from './errors.mjs'

// Local filesystem implementation of the storage interface (see ./index.mjs).
// Used by the unit tests and for local end-to-end runs. Writes are create-only
// and atomic: data goes to a hidden ".partial-*" file first, then link(2) puts
// it at the final name, which fails with EEXIST if the name is taken.
export class LocalStorage {
  constructor(rootDir) {
    if (typeof rootDir !== 'string' || rootDir === '') throw new TypeError('LocalStorage needs a root directory')
    this.root = path.resolve(rootDir)
  }

  describe() {
    return `local directory ${this.root}`
  }

  pathFor(key) {
    assertValidKey(key)
    return path.join(this.root, ...key.split('/'))
  }

  async list(prefix = '') {
    const results = []
    const walk = async (dir, keyPrefix) => {
      let entries
      try {
        entries = await readdir(dir, {withFileTypes: true})
      } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.partial-')) continue
        const key = `${keyPrefix}${entry.name}`
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full, `${key}/`)
        } else if (entry.isFile() && key.startsWith(prefix)) {
          const info = await stat(full)
          results.push({key, size: info.size})
        }
      }
    }
    await walk(this.root, '')
    results.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return results
  }

  async stat(key) {
    try {
      const info = await stat(this.pathFor(key))
      return info.isFile() ? {size: info.size} : null
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async readBuffer(key) {
    return readFile(this.pathFor(key))
  }

  async downloadToFile(key, destPath) {
    await mkdir(path.dirname(destPath), {recursive: true})
    await copyFile(this.pathFor(key), destPath, fsConstants.COPYFILE_EXCL)
  }

  async createFromBuffer(key, buffer) {
    await this.#createAtomically(key, async (tmpPath) => {
      await writeFile(tmpPath, buffer, {flag: 'wx'})
    })
  }

  async createFromFile(key, srcPath) {
    await this.#createAtomically(key, async (tmpPath) => {
      await copyFile(srcPath, tmpPath, fsConstants.COPYFILE_EXCL)
    })
  }

  async #createAtomically(key, writeTemp) {
    const finalPath = this.pathFor(key)
    const dir = path.dirname(finalPath)
    await mkdir(dir, {recursive: true})
    const tmpPath = path.join(dir, `.partial-${randomBytes(8).toString('hex')}-${path.basename(finalPath)}`)
    try {
      await writeTemp(tmpPath)
      const handle = await open(tmpPath, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await link(tmpPath, finalPath)
      } catch (error) {
        if (error.code === 'EEXIST') throw new ObjectExistsError(key, {cause: error})
        throw error
      }
    } finally {
      await unlink(tmpPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
}
