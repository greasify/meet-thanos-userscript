import { defineConfig } from 'vite'
import userscript from 'vite-userscript-plugin'
import pkg from './package.json' with { type: 'json' }
import { userscriptMatches } from './src/platforms/registry.ts'

export default defineConfig({
  base: './',
  build: {
    minify: true,
    sourcemap: true,
  },
  plugins: [
    userscript({
      entry: 'src/index.ts',
      fileName: 'meet-thanos',
      autoMetaUrls: true,
      header: {
        'name': 'Meet Thanos',
        'version': pkg.version,
        'description': pkg.description,
        'icon': 'greasify.svg',
        'homepage': 'https://greasify.github.io/meet-thanos-userscript/',
        'match': userscriptMatches,
        'exclude': [
          'https://meet.jit.si/v1/*',
        ],
        'run-at': 'document-start',
        'inject-into': 'page',
      },
      server: {
        file: true,
      },
    }),
  ],
})
