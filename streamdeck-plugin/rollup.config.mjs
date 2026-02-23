import resolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

export default {
  input: 'src/plugin.ts',
  output: {
    file: 'com.compsync.streamdeck.sdPlugin/bin/plugin.js',
    format: 'es',
    sourcemap: true,
  },
  external: ['ws'],
  plugins: [
    resolve(),
    typescript(),
  ],
}
