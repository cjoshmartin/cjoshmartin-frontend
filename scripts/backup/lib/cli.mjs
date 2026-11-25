import {appendFile, readFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'

// GitHub Actions workflow commands need %, CR and LF escaped in their message.
function escapeAnnotation(message) {
  return String(message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

export function createLogger({github = process.env.GITHUB_ACTIONS === 'true'} = {}) {
  return {
    info: (message) => console.log(message),
    warn: (message) => (github ? console.log(`::warning::${escapeAnnotation(message)}`) : console.warn(`WARNING: ${message}`)),
    error: (message) => (github ? console.log(`::error::${escapeAnnotation(message)}`) : console.error(`ERROR: ${message}`)),
  }
}

// Adds Markdown to the GitHub job summary when running in Actions.
export async function writeStepSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) return
  await appendFile(file, `${markdown}\n`)
}

export function parseCli(argv, options, usage) {
  let parsed
  try {
    parsed = parseArgs({args: argv, options: {...options, help: {type: 'boolean', short: 'h'}}, strict: true, allowPositionals: false})
  } catch (error) {
    throw new UsageError(`${error.message}\n\n${usage}`)
  }
  if (parsed.values.help) {
    console.log(usage)
    process.exit(0)
  }
  return parsed.values
}

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

export function parsePositiveInteger(value, name) {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new UsageError(`${name} must be a positive integer, got ${value}`)
  return Number(value)
}

export async function readToolInfo() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  return {name: pkg.name, version: pkg.version}
}
