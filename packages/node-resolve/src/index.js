/* eslint-disable no-param-reassign, no-shadow, no-undefined */
import { dirname, extname, normalize, resolve, sep } from 'path';

import fs, { realpathSync } from 'fs';

import builtinList from 'builtin-modules';
import resolveId from 'resolve';
import isModule from 'is-module';
import { createFilter } from '@rollup/pluginutils';

import { peerDependencies } from '../package.json';

const builtins = new Set(builtinList);

const ES6_BROWSER_EMPTY = '\0node-resolve:empty.js';
// It is important that .mjs occur before .js so that Rollup will interpret npm modules
// which deploy both ESM .mjs and CommonJS .js files as ESM.
const DEFAULT_EXTS = ['.mjs', '.js', '.json', '.node'];

const existsAsync = (file) => new Promise((fulfil) => fs.exists(file, fulfil));

const readFileAsync = (file) =>
  new Promise((fulfil, reject) =>
    fs.readFile(file, (err, contents) => (err ? reject(err) : fulfil(contents)))
  );

const realpathAsync = (file) =>
  new Promise((fulfil, reject) =>
    fs.realpath(file, (err, contents) => (err ? reject(err) : fulfil(contents)))
  );

const statAsync = (file) =>
  new Promise((fulfil, reject) =>
    fs.stat(file, (err, contents) => (err ? reject(err) : fulfil(contents)))
  );

const cache = (fn) => {
  const cache = new Map();
  const wrapped = (param, done) => {
    if (cache.has(param) === false) {
      cache.set(
        param,
        fn(param).catch((err) => {
          cache.delete(param);
          throw err;
        })
      );
    }
    return cache.get(param).then((result) => done(null, result), done);
  };
  wrapped.clear = () => cache.clear();
  return wrapped;
};

const ignoreENOENT = (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
};

const readFileCached = cache(readFileAsync);

const isDirCached = cache((file) =>
  statAsync(file).then((stat) => stat.isDirectory(), ignoreENOENT)
);

const isFileCached = cache((file) => statAsync(file).then((stat) => stat.isFile(), ignoreENOENT));

function getMainFields(options) {
  let mainFields;
  if (options.mainFields) {
    if ('module' in options || 'main' in options || 'jsnext' in options) {
      throw new Error(
        `node-resolve: do not use deprecated 'module', 'main', 'jsnext' options with 'mainFields'`
      );
    }
    ({ mainFields } = options);
  } else {
    mainFields = [];
    [
      ['module', 'module', true],
      ['jsnext', 'jsnext:main', false],
      ['main', 'main', true]
    ].forEach(([option, field, defaultIncluded]) => {
      if (option in options) {
        // eslint-disable-next-line no-console
        console.warn(
          `node-resolve: setting options.${option} is deprecated, please override options.mainFields instead`
        );
        if (options[option]) {
          mainFields.push(field);
        }
      } else if (defaultIncluded) {
        mainFields.push(field);
      }
    });
  }
  if (options.browser && mainFields.indexOf('browser') === -1) {
    return ['browser'].concat(mainFields);
  }
  if (!mainFields.length) {
    throw new Error(`Please ensure at least one 'mainFields' value is specified`);
  }
  return mainFields;
}

const alwaysNull = () => null;

const resolveIdAsync = (file, opts) =>
  new Promise((fulfil, reject) =>
    resolveId(file, opts, (err, contents) => (err ? reject(err) : fulfil(contents)))
  );

// Resolve module specifiers in order. Promise resolves to the first
// module that resolves successfully, or the error that resulted from
// the last attempted module resolution.
function resolveImportSpecifiers(importSpecifierList, resolveOptions) {
  let p = Promise.resolve();
  for (let i = 0; i < importSpecifierList.length; i++) {
    p = p.then((v) => {
      // if we've already resolved to something, just return it.
      if (v) return v;

      return resolveIdAsync(importSpecifierList[i], resolveOptions);
    });

    if (i < importSpecifierList.length - 1) {
      // swallow MODULE_NOT_FOUND errors from all but the last resolution
      p = p.catch((err) => {
        if (err.code !== 'MODULE_NOT_FOUND') {
          throw err;
        }
      });
    }
  }

  return p;
}

// returns the imported package name for bare module imports
function getPackageName(id) {
  if (id.startsWith('.') || id.startsWith('/')) {
    return null;
  }

  const split = id.split('/');

  // @my-scope/my-package/foo.js -> @my-scope/my-package
  // @my-scope/my-package -> @my-scope/my-package
  if (split[0][0] === '@') {
    return `${split[0]}/${split[1]}`;
  }

  // my-package/foo.js -> my-package
  // my-package -> my-package
  return split[0];
}

export default function nodeResolve(options = {}) {
  const mainFields = getMainFields(options);
  const useBrowserOverrides = mainFields.indexOf('browser') !== -1;
  const dedupe = options.dedupe || [];
  const isPreferBuiltinsSet = options.preferBuiltins === true || options.preferBuiltins === false;
  const preferBuiltins = isPreferBuiltinsSet ? options.preferBuiltins : true;
  const customResolveOptions = options.customResolveOptions || {};
  const rootDir = options.rootDir || process.cwd();
  const { jail } = options;
  const only = Array.isArray(options.only)
    ? options.only.map((o) =>
        o instanceof RegExp
          ? o
          : new RegExp(`^${String(o).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')}$`)
      )
    : null;
  const browserMapCache = new Map();
  let preserveSymlinks;

  if (options.skip) {
    throw new Error(
      'options.skip is no longer supported — you should use the main Rollup `external` option instead'
    );
  }

  const extensions = options.extensions || DEFAULT_EXTS;
  const packageInfoCache = new Map();
  const idToPackageInfo = new Map();

  const shouldDedupe =
    typeof dedupe === 'function'
      ? dedupe
      : (importee) => dedupe.includes(importee) || dedupe.includes(getPackageName(importee));

  function getCachedPackageInfo(pkg, pkgPath) {
    if (packageInfoCache.has(pkgPath)) {
      return packageInfoCache.get(pkgPath);
    }

    // browserify/resolve doesn't realpath paths returned in its packageFilter callback
    if (!preserveSymlinks) {
      pkgPath = realpathSync(pkgPath);
    }

    const pkgRoot = dirname(pkgPath);

    const packageInfo = {
      // copy as we are about to munge the `main` field of `pkg`.
      packageJson: Object.assign({}, pkg),

      // path to package.json file
      packageJsonPath: pkgPath,

      // directory containing the package.json
      root: pkgRoot,

      // which main field was used during resolution of this module (main, module, or browser)
      resolvedMainField: 'main',

      // whether the browser map was used to resolve the entry point to this module
      browserMappedMain: false,

      // the entry point of the module with respect to the selected main field and any
      // relevant browser mappings.
      resolvedEntryPoint: ''
    };

    let overriddenMain = false;
    for (let i = 0; i < mainFields.length; i++) {
      const field = mainFields[i];
      if (typeof pkg[field] === 'string') {
        pkg.main = pkg[field];
        packageInfo.resolvedMainField = field;
        overriddenMain = true;
        break;
      }
    }

    const internalPackageInfo = {
      cachedPkg: pkg,
      hasModuleSideEffects: alwaysNull,
      hasPackageEntry: overriddenMain !== false || mainFields.indexOf('main') !== -1,
      packageBrowserField:
        useBrowserOverrides &&
        typeof pkg.browser === 'object' &&
        Object.keys(pkg.browser).reduce((browser, key) => {
          let resolved = pkg.browser[key];
          if (resolved && resolved[0] === '.') {
            resolved = resolve(pkgRoot, resolved);
          }
          browser[key] = resolved;
          if (key[0] === '.') {
            const absoluteKey = resolve(pkgRoot, key);
            browser[absoluteKey] = resolved;
            if (!extname(key)) {
              extensions.reduce((browser, ext) => {
                browser[absoluteKey + ext] = browser[key];
                return browser;
              }, browser);
            }
          }
          return browser;
        }, {}),
      packageInfo
    };

    const browserMap = internalPackageInfo.packageBrowserField;
    if (
      useBrowserOverrides &&
      typeof pkg.browser === 'object' &&
      // eslint-disable-next-line no-prototype-builtins
      browserMap.hasOwnProperty(pkg.main)
    ) {
      packageInfo.resolvedEntryPoint = browserMap[pkg.main];
      packageInfo.browserMappedMain = true;
    } else {
      // index.node is technically a valid default entrypoint as well...
      packageInfo.resolvedEntryPoint = resolve(pkgRoot, pkg.main || 'index.js');
      packageInfo.browserMappedMain = false;
    }

    const packageSideEffects = pkg.sideEffects;
    if (typeof packageSideEffects === 'boolean') {
      internalPackageInfo.hasModuleSideEffects = () => packageSideEffects;
    } else if (Array.isArray(packageSideEffects)) {
      internalPackageInfo.hasModuleSideEffects = createFilter(packageSideEffects, null, {
        resolve: pkgRoot
      });
    }

    packageInfoCache.set(pkgPath, internalPackageInfo);
    return internalPackageInfo;
  }

  return {
    name: 'node-resolve',

    buildStart(options) {
      ({ preserveSymlinks } = options);
      const [major, minor] = this.meta.rollupVersion.split('.').map(Number);
      const minVersion = peerDependencies.rollup.slice(2);
      const [minMajor, minMinor] = minVersion.split('.').map(Number);
      if (major < minMajor || (major === minMajor && minor < minMinor)) {
        this.error(
          `Insufficient Rollup version: "rollup-plugin-node-resolve" requires at least rollup@${minVersion} but found rollup@${this.meta.rollupVersion}.`
        );
      }
    },

    generateBundle() {
      readFileCached.clear();
      isFileCached.clear();
      isDirCached.clear();
    },

    resolveId(importee, importer) {
      if (importee === ES6_BROWSER_EMPTY) {
        return importee;
      }
      // ignore IDs with null character, these belong to other plugins
      if (/\0/.test(importee)) return null;

      const basedir = !importer || shouldDedupe(importee) ? rootDir : dirname(importer);

      // https://github.com/defunctzombie/package-browser-field-spec
      const browser = browserMapCache.get(importer);
      if (useBrowserOverrides && browser) {
        const resolvedImportee = resolve(basedir, importee);
        if (browser[importee] === false || browser[resolvedImportee] === false) {
          return ES6_BROWSER_EMPTY;
        }
        const browserImportee =
          browser[importee] ||
          browser[resolvedImportee] ||
          browser[`${resolvedImportee}.js`] ||
          browser[`${resolvedImportee}.json`];
        if (browserImportee) {
          importee = browserImportee;
        }
      }

      const parts = importee.split(/[/\\]/);
      let id = parts.shift();

      if (id[0] === '@' && parts.length > 0) {
        // scoped packages
        id += `/${parts.shift()}`;
      } else if (id[0] === '.') {
        // an import relative to the parent dir of the importer
        id = resolve(basedir, importee);
      }

      if (only && !only.some((pattern) => pattern.test(id))) return null;

      let hasModuleSideEffects = alwaysNull;
      let hasPackageEntry = true;
      let packageBrowserField = false;
      let packageInfo;

      const resolveOptions = {
        basedir,
        packageFilter(pkg, pkgPath) {
          let cachedPkg;
          ({
            packageInfo,
            cachedPkg,
            hasModuleSideEffects,
            hasPackageEntry,
            packageBrowserField
          } = getCachedPackageInfo(pkg, pkgPath));

          return cachedPkg;
        },
        readFile: readFileCached,
        isFile: isFileCached,
        isDirectory: isDirCached,
        extensions
      };

      if (preserveSymlinks !== undefined) {
        resolveOptions.preserveSymlinks = preserveSymlinks;
      }

      const importSpecifierList = [];

      if (importer === undefined && !importee[0].match(/^\.?\.?\//)) {
        // For module graph roots (i.e. when importer is undefined), we
        // need to handle 'path fragments` like `foo/bar` that are commonly
        // found in rollup config files. If importee doesn't look like a
        // relative or absolute path, we make it relative and attempt to
        // resolve it. If we don't find anything, we try resolving it as we
        // got it.
        importSpecifierList.push(`./${importee}`);
      }

      const importeeIsBuiltin = builtins.has(importee);

      if (importeeIsBuiltin && (!preferBuiltins || !isPreferBuiltinsSet)) {
        // The `resolve` library will not resolve packages with the same
        // name as a node built-in module. If we're resolving something
        // that's a builtin, and we don't prefer to find built-ins, we
        // first try to look up a local module with that name. If we don't
        // find anything, we resolve the builtin which just returns back
        // the built-in's name.
        importSpecifierList.push(`${importee}/`);
      }

      importSpecifierList.push(importee);
      return resolveImportSpecifiers(
        importSpecifierList,
        Object.assign(resolveOptions, customResolveOptions)
      )
        .then((resolved) => {
          if (resolved && packageBrowserField) {
            if (Object.prototype.hasOwnProperty.call(packageBrowserField, resolved)) {
              if (!packageBrowserField[resolved]) {
                browserMapCache.set(resolved, packageBrowserField);
                return ES6_BROWSER_EMPTY;
              }
              resolved = packageBrowserField[resolved];
            }
            browserMapCache.set(resolved, packageBrowserField);
          }

          if (hasPackageEntry && !preserveSymlinks && resolved) {
            return existsAsync(resolved).then((exists) =>
              exists ? realpathAsync(resolved) : resolved
            );
          }
          return resolved;
        })
        .then((resolved) => {
          idToPackageInfo.set(resolved, packageInfo);

          if (hasPackageEntry) {
            if (builtins.has(resolved) && preferBuiltins && isPreferBuiltinsSet) {
              return null;
            } else if (importeeIsBuiltin && preferBuiltins) {
              if (!isPreferBuiltinsSet) {
                this.warn(
                  `preferring built-in module '${importee}' over local alternative ` +
                    `at '${resolved}', pass 'preferBuiltins: false' to disable this ` +
                    `behavior or 'preferBuiltins: true' to disable this warning`
                );
              }
              return null;
            } else if (jail && resolved.indexOf(normalize(jail.trim(sep))) !== 0) {
              return null;
            }
          }

          if (resolved && options.modulesOnly) {
            return readFileAsync(resolved, 'utf-8').then((code) =>
              isModule(code)
                ? { id: resolved, moduleSideEffects: hasModuleSideEffects(resolved) }
                : null
            );
          }
          return { id: resolved, moduleSideEffects: hasModuleSideEffects(resolved) };
        })
        .catch(() => null);
    },

    load(importee) {
      if (importee === ES6_BROWSER_EMPTY) {
        return 'export default {};';
      }
      return null;
    },

    getPackageInfoForId(id) {
      return idToPackageInfo.get(id);
    }
  };
}
