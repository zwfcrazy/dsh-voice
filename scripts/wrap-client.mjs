// 把 tsdown 的 CJS 产出 lib/client.js 包成 dsh client-module 的 loader 注册格式：
//   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
// 与官方包（dsh-client-ui-settings 等）的 lib/client.js 逐字节同构：
// 工厂只收一个 require 参数，内部自建 module/exports 并 return module.exports。
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const id = pkg.name
const src = join(here, '..', 'lib', 'client.cjs')
const dest = join(here, '..', 'lib', 'client.js')

const body = readFileSync(src, 'utf8')
if (body.includes('__ModuleLoader__')) {
  console.log(`lib/client.js already wrapped — skip (${body.length}B)`)
  process.exit(0)
}
const out = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(id)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${body}
		return module.exports;
	}
});
`
writeFileSync(dest, out)
unlinkSync(src)
console.log(`wrapped lib/client.js for ${id} (${out.length}B)`)
