const path = require('path');
const asyncEach = require('async/each');
const CSON = require('season');
const fs = require('fs-plus');
const { Emitter, CompositeDisposable } = require('event-kit');
const dedent = require('dedent');
const AbstractPackage = require('./abstract-package');

const CompileCache = require('./compile-cache');
const ModuleCache = require('./module-cache');
const BufferedProcess = require('./buffered-process');
const { requireModule } = require('./module-utils');

// Extended: Loads and activates a package's main module and resources such as
// stylesheets, keymaps, grammar, editor properties, and menus.
module.exports = class Package extends AbstractPackage {
  /*
  Section: Construction
  */

  constructor(params) {
    this.config = params.config;
    this.packageManager = params.packageManager;
    this.styleManager = params.styleManager;
    this.commandRegistry = params.commandRegistry;
    this.keymapManager = params.keymapManager;
    this.notificationManager = params.notificationManager;
    this.grammarRegistry = params.grammarRegistry;
    this.themeManager = params.themeManager;
    this.menuManager = params.menuManager;
    this.contextMenuManager = params.contextMenuManager;
    this.deserializerManager = params.deserializerManager;
    this.viewRegistry = params.viewRegistry;
    this.emitter = new Emitter();

    this.mainModule = null;
    this.path = params.path;
    this.preloadedPackage = params.preloadedPackage;
    this.metadata =
      params.metadata || this.packageManager.loadPackageMetadata(this.path);
    this.bundledPackage =
      params.bundledPackage != null
        ? params.bundledPackage
        : this.packageManager.isBundledPackagePath(this.path);
    this.name =
      (this.metadata && this.metadata.name) ||
      params.name ||
      path.basename(this.path);
    this.reset();
  }

  /*
  Section: Event Subscription
  */

  // Essential: Invoke the given callback when all packages have been activated.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  // onDidDeactivate(callback) {
  //   return this.emitter.on('did-deactivate', callback);
  // }

  /*
  Section: Instance Methods
  */

  enable() {
    return this.config.removeAtKeyPath('core.disabledPackages', this.name);
  }

  disable() {
    return this.config.pushAtKeyPath('core.disabledPackages', this.name);
  }

  getType() {
    return 'atom';
  }

  getStyleSheetPriority() {
    return 0;
  }

  preload() {
    this.loadKeymaps();
    this.loadMenus();
    this.registerDeserializerMethods();
    this.activateCoreStartupServices();
    this.registerURIHandler();
    this.configSchemaRegisteredOnLoad = this.registerConfigSchemaFromMetadata();
    this.requireMainModule();
    this.settingsPromise = this.loadSettings();

    this.activationDisposables = new CompositeDisposable();
    this.activateKeymaps();
    this.activateMenus();
    for (let settings of this.settings) {
      settings.activate(this.config);
    }
    this.settingsActivated = true;
  }


  load() {
    this.measure('loadTime', () => {
      try {
        ModuleCache.add(this.path, this.metadata);

        this.loadKeymaps();
        this.loadMenus();
        this.loadStylesheets();
        this.registerDeserializerMethods();
        this.activateCoreStartupServices();
        this.registerURIHandler();
        this.registerTranspilerConfig();
        this.configSchemaRegisteredOnLoad = this.registerConfigSchemaFromMetadata();
        this.settingsPromise = this.loadSettings();
        if (this.shouldRequireMainModuleOnLoad() && this.mainModule == null) {
          this.requireMainModule();
        }
      } catch (error) {
        this.handleError(`Failed to load the ${this.name} package`, error);
      }
    });
    return this;
  }


  activate() {
    if (!this.grammarsPromise) this.grammarsPromise = this.loadGrammars();
    if (!this.activationPromise) {
      this.activationPromise = new Promise((resolve, reject) => {
        this.resolveActivationPromise = resolve;
        this.measure('activateTime', () => {
          try {
            this.activateResources();
            if (this.activationShouldBeDeferred()) {
              return this.subscribeToDeferredActivation();
            } else {
              return this.activateNow();
            }
          } catch (error) {
            return this.handleError(
              `Failed to activate the ${this.name} package`,
              error
            );
          }
        });
      });
    }

    return Promise.all([
      this.grammarsPromise,
      this.settingsPromise,
      this.activationPromise
    ]);
  }
}
