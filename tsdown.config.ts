import { defineConfig } from 'tsdown'

export default defineConfig([
  // host 半区：DSH node 进程加载，ESM（package.json "type":"module"）
  { entry: ['src/index.ts'], format: 'esm', dts: false, outDir: 'lib', sourcemap: false },
  // preset 私有工具入口（jarvis-voice 行 name:'dsh-voice/tools'；P7c 第二层工具）
  { entry: { tools: 'src/tools.ts' }, format: 'esm', dts: false, outDir: 'lib', sourcemap: false },
  // client 半区：CJS 产出交给 wrap-client.mjs 包成 __ModuleLoader__ 工厂格式。
  // react 必须保持 external —— 浏览器端由模块系统静态表提供。
  { entry: { client: 'src/client/index.ts' }, format: 'cjs', dts: false, outDir: 'lib', sourcemap: false, external: ['react'] },
])
