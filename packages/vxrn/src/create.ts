import { readFile } from 'fs/promises'
import { dirname, join, relative } from 'path'

import * as babel from '@babel/core'
import viteReactPlugin, { swcTransform, transformForBuild } from '@vxrn/vite-native-swc'
import react from '@vitejs/plugin-react-swc'
import { parse } from 'es-module-lexer'
import { pathExists } from 'fs-extra'
import { InlineConfig, build, createServer, mergeConfig, resolveConfig } from 'vite'

import { clientInjectionsPlugin } from './dev/clientInjectPlugin'
import { createDevServer } from './dev/createDevServer'
import { HMRListener } from './types'
import { StartOptions } from './types'
import { nativePlugin } from './nativePlugin'
import { getVitePath } from './getVitePath'

export const create = async (options: StartOptions) => {
  const { host = '127.0.0.1', root, nativePort = 8081, webPort } = options
  // used for normalizing hot reloads
  let entryRoot = ''

  const packageRootDir = join(__dirname, '..')
  const templateFile = join(packageRootDir, 'react-native-template.js')

  // react native port (it scans 19000 +5)
  const hmrListeners: HMRListener[] = []
  const hotUpdatedCJSFiles = new Map<string, string>()

  let serverConfig = {
    root,
    mode: 'development',
    clearScreen: false,

    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        'react-native': 'react-native-web',
      },
    },

    optimizeDeps: {
      include: ['react'],
    },

    plugins: [
      react(),

      {
        name: 'tamagui-client-transform',

        async handleHotUpdate({ read, modules, file }) {
          try {
            if (!file.includes('/src/')) {
              return
            }

            const [module] = modules
            if (!module) return

            const id = module?.url || file.replace(root, '')

            const code = await read()

            // got a weird pre compiled file on startup
            if (code.startsWith(`'use strict';`)) return

            if (!code) {
              return
            }

            let source = code

            // we have to remove jsx before we can parse imports...
            source = (await transformForBuild(id, source))?.code || ''

            const importsMap = {}

            // parse imports of modules into ids:
            // eg `import x from '@tamagui/core'` => `import x from '/me/node_modules/@tamagui/core/index.js'`
            const [imports] = parse(source)

            let accumulatedSliceOffset = 0

            for (const specifier of imports) {
              const { n: importName, s: start } = specifier

              if (importName) {
                const id = await getVitePath(entryRoot, file, importName)
                if (!id) {
                  console.warn('???')
                  continue
                }

                importsMap[id] = id.replace(/^(\.\.\/)+/, '')

                // replace module name with id for hmr
                const len = importName.length
                const extraLen = id.length - len
                source =
                  source.slice(0, start + accumulatedSliceOffset) +
                  id +
                  source.slice(start + accumulatedSliceOffset + len)
                accumulatedSliceOffset += extraLen
              }
            }

            // then we have to convert to commonjs..
            source =
              (
                await swcTransform(id, source, {
                  mode: 'serve-cjs',
                })
              )?.code || ''

            if (!source) {
              throw '❌ no source'
            }

            const hotUpdateSource = `exports = ((exports) => {
              const require = createRequire(${JSON.stringify(importsMap, null, 2)})
              ${source
                .replace(`import.meta.hot.accept(() => {})`, ``)
                // replace import.meta.glob with empty array in hot reloads
                .replaceAll(
                  /import.meta.glob\(.*\)/gi,
                  `globalThis['__importMetaGlobbed'] || {}`
                )};
              return exports })({})`

            if (process.env.DEBUG === 'vxrn') {
              console.info(`Sending hot update`, hotUpdateSource)
            }

            hotUpdatedCJSFiles.set(id, hotUpdateSource)
          } catch (err) {
            console.error(`Error processing hmr update:`, err)
          }
        },
      },
    ],

    server: {
      cors: true,
      port: webPort,
      host,
    },
  } satisfies InlineConfig

  if (options.webConfig) {
    serverConfig = mergeConfig(serverConfig, options.webConfig) as any
  }

  // first resolve config so we can pass into client plugin, then add client plugin:
  const resolvedConfig = await resolveConfig(serverConfig, 'serve')

  const viteRNClientPlugin = clientInjectionsPlugin(resolvedConfig)

  serverConfig = {
    ...serverConfig,
    plugins: [...serverConfig.plugins],
  }

  const viteServer = await createServer(serverConfig)
  // add here a proper loader for .png and other files
  // this fakes vite into thinking its loading files, so it hmrs in native mode despite not requesting
  viteServer.watcher.addListener('change', async (path) => {
    const id = path.replace(process.cwd(), '')
    // TODO: Assets are not dynamically resolved

    // just so it thinks its loaded
    try {
      void viteServer.transformRequest(id)
    } catch (err) {
      // ok
      console.info('err', err)
    }
  })

  let isBuilding: Promise<string> | null = null

  const nativeServer = await createDevServer(
    {
      root,
      port: nativePort,
      host,
    },
    {
      hotUpdatedCJSFiles,
      listenForHMR(cb) {
        hmrListeners.push(cb)
      },
      getIndexBundle: getBundleCode,
      indexJson: getIndexJsonResponse({ port: nativePort, root }),
    }
  )

  return {
    nativeServer: nativeServer.instance,
    viteServer,

    async start() {
      await Promise.all([viteServer.listen(), nativeServer.start()])

      return {
        closePromise: new Promise((res) => viteServer.httpServer?.on('close', res)),
      }
    },

    stop: async () => {
      await Promise.all([nativeServer.stop(), viteServer.close()])
    },
  }

  async function getBundleCode() {
    if (process.env.LOAD_TMP_BUNDLE) {
      // for easier quick testing things:
      const tmpBundle = join(process.cwd(), 'bundle.tmp.js')
      if (await pathExists(tmpBundle)) {
        console.info(
          '⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️ returning temp bundle ⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️',
          tmpBundle
        )
        return await readFile(tmpBundle, 'utf-8')
      }
    }

    if (isBuilding) {
      const res = await isBuilding
      return res
    }

    let done
    isBuilding = new Promise((res) => {
      done = res
    })

    const jsxRuntime = {
      alias: 'virtual:react-jsx',
      contents: await readFile(
        require.resolve('@vxrn/react-native-prebuilt/jsx-runtime'),
        'utf-8'
      ),
    } as const

    const virtualModules = {
      'react-native': {
        alias: 'virtual:react-native',
        contents: await readFile(require.resolve('@vxrn/react-native-prebuilt'), 'utf-8'),
      },
      react: {
        alias: 'virtual:react',
        contents: await readFile(
          require.resolve('@vxrn/react-native-prebuilt/react'),
          'utf-8'
        ),
      },
      'react/jsx-runtime': jsxRuntime,
      'react/jsx-dev-runtime': jsxRuntime,
    } as const

    const swapRnPlugin = {
      name: `swap-react-native`,
      enforce: 'pre',

      resolveId(id) {
        if (id.startsWith('react-native/Libraries')) {
          return `virtual:rn-internals:${id}`
        }

        for (const targetId in virtualModules) {
          if (id === targetId || id.includes(`node_modules/${targetId}/`)) {
            const info = virtualModules[targetId]
            return info.alias
          }
        }
      },

      load(id) {
        if (id.startsWith('virtual:rn-internals')) {
          const idOut = id.replace('virtual:rn-internals:', '')
          return `const val = __cachedModules["${idOut}"]
          export const PressabilityDebugView = val.PressabilityDebugView
          export default val ? val.default || val : val`
        }

        for (const targetId in virtualModules) {
          const info = virtualModules[targetId as keyof typeof virtualModules]
          if (id === info.alias) {
            return info.contents
          }
        }
      },
    } as const

    async function babelReanimated(input: string, filename: string) {
      console.log('babel reanimated', filename)
      return await new Promise<string>((res, rej) => {
        babel.transform(
          input,
          {
            plugins: ['react-native-reanimated/plugin'],
            filename,
          },
          (err: any, result) => {
            if (!result || err) rej(err || 'no res')
            res(result!.code!)
          }
        )
      })
    }

    // build app
    let buildConfig = {
      plugins: [
        swapRnPlugin,

        {
          name: 'reanimated',

          async transform(code, id) {
            if (code.includes('worklet')) {
              return await babelReanimated(code, id)
            }
            return
          },
        },
        {
          name: 'assets',
          async transform(code, id) {
            if (id.includes('.png')) {
              return `
              const AssetRegistry = require('react-native/Libraries/Image/AssetRegistry');
              export default AssetRegistry.registerAsset({
                __packager_asset: true,
                scales: [1], 
                name: ${JSON.stringify('rnw.png')},
                type: ${JSON.stringify('png')},
                hash: ${JSON.stringify('oasdjfopajisdfopiasdjf')},
                httpServerLocation: '/assets/rnw.png',
                fileSystemLocation: '/Users/szymonrybczak/'
              });
              
              `
            }
          }
        },

        viteRNClientPlugin,

        nativePlugin({
          root: options.root,
          port: nativePort,
          mode: 'build',
        }),

        viteReactPlugin({
          tsDecorators: true,
          mode: 'build',
        }),
      ],
      appType: 'custom',
      root,
      clearScreen: false,

      build: {
        ssr: false,
        minify: false,
        commonjsOptions: {
          transformMixedEsModules: true,
        },
        rollupOptions: {
          treeshake: false,
          preserveEntrySignatures: 'strict',
          output: {
            preserveModules: true,
            format: 'cjs',
          },
        },
      },

      optimizeDeps: {
        include: ['react-native']
      },

      mode: 'development',
      define: {
        'process.env.NODE_ENV': `"development"`,
      },
    } satisfies InlineConfig

    if (options.buildConfig) {
      buildConfig = mergeConfig(buildConfig, options.buildConfig) as any
    }

    // this fixes my swap-react-native plugin not being called pre 😳
    await resolveConfig(buildConfig, 'build')

    const buildOutput = await build(buildConfig)

    if (!('output' in buildOutput)) {
      throw `❌`
    }

    let appCode = buildOutput.output
      // entry last
      .sort((a, b) => (a['isEntry'] ? 1 : -1))
      .map((outputModule) => {
        if (outputModule.type == 'chunk') {
          const importsMap = {}
          for (const imp of outputModule.imports) {
            const relativePath = relative(dirname(outputModule.fileName), imp)
            importsMap[relativePath[0] === '.' ? relativePath : './' + relativePath] = imp
          }

          if (outputModule.isEntry) {
            entryRoot = dirname(outputModule.fileName)
          }

          return `
___modules___["${outputModule.fileName}"] = ((exports, module) => {
  const require = createRequire(${JSON.stringify(importsMap, null, 2)})
  console.log('xd')
  ${outputModule.code}
})

${outputModule.isEntry
              ? `
// run entry
const __require = createRequire({})
__require("react-native")
__require("${outputModule.fileName}")
`
              : ''
            }
`
        }
      })
      .join('\n')

    if (!appCode) {
      throw `❌`
    }

    appCode = appCode
      // this can be done in the individual file transform
      .replaceAll('undefined.accept(() => {})', '')
      .replaceAll('undefined.accept(function() {});', '') // swc

    const out = (await readFile(templateFile, 'utf-8')) + appCode

    done(out)
    isBuilding = null

    return out
  }
}

function getIndexJsonResponse({ port, root }: { port: number | string; root }) {
  return {
    name: 'myapp',
    slug: 'myapp',
    scheme: 'myapp',
    version: '1.0.0',
    jsEngine: 'jsc',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
      imageUrl: 'http://127.0.0.1:8081/assets/./assets/splash.png',
    },
    updates: { fallbackToCacheTimeout: 0 },
    assetBundlePatterns: ['**/*'],
    ios: { supportsTablet: true, bundleIdentifier: 'com.natew.myapp' },
    android: {
      package: 'com.tamagui.myapp',
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#FFFFFF',
        foregroundImageUrl: 'http://127.0.0.1:8081/assets/./assets/adaptive-icon.png',
      },
    },
    web: { favicon: './assets/favicon.png' },
    extra: { eas: { projectId: '061b4470-78c7-4d6a-b850-8167fb0a3434' } },
    _internal: {
      isDebug: false,
      projectRoot: root,
      dynamicConfigPath: null,
      staticConfigPath: join(root, 'app.json'),
      packageJsonPath: join(root, 'package.json'),
    },
    sdkVersion: '47.0.0',
    platforms: ['ios', 'android', 'web'],
    iconUrl: `http://127.0.0.1:${port}/assets/./assets/icon.png`,
    debuggerHost: `127.0.0.1:${port}`,
    logUrl: `http://127.0.0.1:${port}/logs`,
    developer: { tool: 'expo-cli', projectRoot: root },
    packagerOpts: { dev: true },
    mainModuleName: 'index',
    __flipperHack: 'React Native packager is running',
    hostUri: `127.0.0.1:${port}`,
    bundleUrl: `http://127.0.0.1:${port}/index.bundle?platform=ios&dev=true&hot=false&lazy=true`,
    id: '@anonymous/myapp-473c4543-3c36-4786-9db1-c66a62ac9b78',
  }
}
