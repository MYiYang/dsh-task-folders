// Dump the header + events of a task archive (read-only).
import fs from 'node:fs'
import { inflateFrames } from '../lib/archive.js'

const dir = process.argv[2]
const log = inflateFrames(fs.readFileSync(`${dir}/session.v4.jsonl.zstd`))
const lines = log.split('\n').filter((line) => line !== '')
console.log(`lines: ${lines.length}`)
for (const line of lines.slice(0, 12)) {
  const record = JSON.parse(line)
  const brief =
    record.type === 'session'
      ? `HEADER id=${record.id} cwd=${record.cwd} createdAt=${new Date(record.createdAt).toISOString()} origin=${record.origin ?? '-'}`
      : `seq=${record.seq} ${record.type} ${JSON.stringify(record.data).slice(0, 160)}`
  console.log(`  ${brief}`)
}
