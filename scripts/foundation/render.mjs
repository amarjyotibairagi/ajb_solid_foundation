#!/usr/bin/env node
// Renders a template by replacing {{NAME}} with process.env.NAME.
// Usage: node render.mjs <template> <output> [octal-mode]
// Fails, writing nothing, if any placeholder has no value.
import fs from 'node:fs'
import path from 'node:path'

const [template, output, mode = '644'] = process.argv.slice(2)
if (!template || !output) {
  console.error('usage: render.mjs <template> <output> [mode]')
  process.exit(2)
}
const source = fs.readFileSync(template, 'utf8')
const missing = new Set()
const rendered = source.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name) => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    missing.add(name)
    return ''
  }
  return value
})
if (missing.size) {
  console.error(`render: ${path.basename(template)} needs values for: ${[...missing].join(', ')}`)
  process.exit(1)
}
fs.mkdirSync(path.dirname(output), { recursive: true })
const temporary = `${output}.tmp-${process.pid}`
fs.writeFileSync(temporary, rendered, { mode: parseInt(mode, 8) })
fs.chmodSync(temporary, parseInt(mode, 8))
fs.renameSync(temporary, output)
