// Minimal asar reader for the new (integrity-aware) asar format:
//   [uint32 = 4 marker][uint32 pickleSize][pickle: [uint32 jsonLen][json][pad]]
// Offsets inside the tree are strings; file data starts at 8 + pickleSize.
// Usage: node asar-read.mjs <asarPath> [list <prefix> | dump <innerPath>]
import fs from 'node:fs'

const asarPath = process.argv[2]
const command = process.argv[3] ?? 'list'
const arg = process.argv[4] ?? ''

const fd = fs.openSync(asarPath, 'r')
const sizeBuf = Buffer.alloc(16)
fs.readSync(fd, sizeBuf, 0, 16, 0)
const pickleSize = sizeBuf.readUInt32LE(4)
const jsonLen = sizeBuf.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
const tree = JSON.parse(jsonBuf.toString('utf8'))
const dataStart = 8 + pickleSize

function* walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const inner = prefix ? `${prefix}/${name}` : name
    if (value.files) yield* walk(value, inner)
    else yield { inner, node: value }
  }
}

function listEntries() {
  const rows = []
  for (const entry of walk(tree, '')) {
    if (!entry.inner.startsWith(arg)) continue
    rows.push(`${entry.inner}  ${entry.node.size}`)
  }
  console.log(rows.sort().join('\n'))
}

function dumpEntry() {
  for (const entry of walk(tree, '')) {
    if (entry.inner !== arg) continue
    const size = Number(entry.node.size)
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, dataStart + Number(entry.node.offset))
    process.stdout.write(buf)
    return true
  }
  console.error(`not found: ${arg}`)
  return false
}

if (command === 'list') listEntries()
else if (command === 'dump' && !dumpEntry()) process.exitCode = 1
fs.closeSync(fd)
