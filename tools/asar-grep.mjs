// Grep inside an asar without unpacking it.
// Usage: node asar-grep.mjs <asarPath> <regex> [innerPrefix] [--context=N] [--max=N]
// Prints `<innerPath>:<line>` for every matching line, folded to 400 chars.
import fs from 'node:fs'

const asarPath = process.argv[2]
const pattern = process.argv[3]
const rest = process.argv.slice(4)
const prefix = rest.find((value) => !value.startsWith('--')) ?? ''
const flag = (name, fallback) => {
  const hit = rest.find((value) => value.startsWith(`--${name}=`))
  return hit === undefined ? fallback : Number(hit.slice(name.length + 3))
}
const max = flag('max', 200)
const context = flag('context', 0)

if (asarPath === undefined || pattern === undefined) {
  console.error('usage: node asar-grep.mjs <asarPath> <regex> [innerPrefix] [--max=N] [--context=N]')
  process.exit(2)
}

const fd = fs.openSync(asarPath, 'r')
const header = Buffer.alloc(16)
fs.readSync(fd, header, 0, 16, 0)
const pickleSize = header.readUInt32LE(4)
const jsonLen = header.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
const tree = JSON.parse(jsonBuf.toString('utf8'))
const dataStart = 8 + pickleSize

function* walk(node, base) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const inner = base ? `${base}/${name}` : name
    if (value.files) yield* walk(value, inner)
    else yield { inner, node: value }
  }
}

const regex = new RegExp(pattern)
let printed = 0
for (const entry of walk(tree, '')) {
  if (!entry.inner.startsWith(prefix)) continue
  const size = Number(entry.node.size)
  const offset = Number(entry.node.offset)
  // 软链 / unpacked 条目没有 size/offset：跳过，否则 readSync 会拿到 NaN。
  if (!Number.isFinite(size) || !Number.isFinite(offset) || size === 0 || size > 8 * 1024 * 1024) continue
  const buf = Buffer.alloc(size)
  fs.readSync(fd, buf, 0, size, dataStart + offset)
  const text = buf.toString('utf8')
  if (!regex.test(text)) continue
  regex.lastIndex = 0
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!regex.test(lines[index])) continue
    regex.lastIndex = 0
    const from = Math.max(0, index - context)
    const to = Math.min(lines.length - 1, index + context)
    for (let cursor = from; cursor <= to; cursor += 1) {
      const mark = cursor === index ? ':' : '-'
      console.log(`${entry.inner}${mark}${cursor + 1}: ${lines[cursor].slice(0, 400)}`)
    }
    printed += 1
    if (printed >= max) {
      console.log(`... stopped at --max=${max}`)
      fs.closeSync(fd)
      process.exit(0)
    }
    index = to
  }
}
fs.closeSync(fd)
