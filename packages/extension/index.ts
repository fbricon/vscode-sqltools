import { commands, env as VSCodeEnv, ExtensionContext, version as VSCodeVersion, window, EventEmitter } from 'vscode';
import { EXT_NAMESPACE, VERSION, AUTHOR, DISPLAY_NAME } from '@sqltools/util/constants';
import { IExtension, IExtensionPlugin, ICommandEvent, ICommandSuccessEvent, CommandEventHandler } from '@sqltools/types';
import { migrateFilesToNewPaths } from '@sqltools/util/path';
import { openExternal } from '@sqltools/vscode/utils';
import Config from '@sqltools/util/config-manager';
import Context from '@sqltools/vscode/context';
import debounce from '@sqltools/util/debounce';
import ErrorHandler from './api/error-handler';
import https from 'https';
import logger from '@sqltools/util/log';
import PluginResourcesMap from '@sqltools/util/plugin-resources';
import SQLToolsLanguageClient from './language-client';
import Timer from '@sqltools/util/telemetry/timer';
import Utils from './api/utils';

const log = logger.extend('main');
// plugins
import ConnectionManagerPlugin from '@sqltools/plugins/connection-manager/extension';
import HistoryManagerPlugin from '@sqltools/plugins/history-manager/extension';
import BookmarksManagerPlugin from '@sqltools/plugins/bookmarks-manager/extension';
import FormatterPlugin from '@sqltools/plugins/formatter/extension';
import telemetry from '@sqltools/util/telemetry';

export class SQLToolsExtension implements IExtension {
  private pluginsQueue: IExtensionPlugin<this>[] = [];
  private extPlugins: { [type: string]: string[] } = {};
  private onWillRunCommandEmitter: EventEmitter<ICommandEvent>;
  private onDidRunCommandSuccessfullyEmitter: EventEmitter<ICommandSuccessEvent>;
  private willRunCommandHooks: { [commands: string]: Array<(evt: ICommandEvent) => void> } = {};
  private didRunCommandSuccessfullyHooks: { [commands: string]: Array<(evt: ICommandSuccessEvent) => void> } = {};
  public client: SQLToolsLanguageClient;
  private loaded: boolean = false;

  public activate = async (): Promise<IExtension> => {
    const activationTimer = new Timer();
    const { installedExtPlugins = {} } = Utils.getlastRunInfo();
    Context.globalState.update('extPlugins', installedExtPlugins || {});
    telemetry.updateOpts({
      extraInfo: {
        sessId: VSCodeEnv.sessionId,
        uniqId: VSCodeEnv.machineId,
        version: VSCodeVersion,
      },
    });
    this.client = new SQLToolsLanguageClient();
    this.onWillRunCommandEmitter = new EventEmitter();
    this.onDidRunCommandSuccessfullyEmitter = new EventEmitter();

    Context.subscriptions.push(
      this.client.start(),
      this.onWillRunCommandEmitter.event(this.onWillRunCommandHandler),
      this.onDidRunCommandSuccessfullyEmitter.event(this.onDidRunCommandSuccessfullyHandler),
    );

    this.registerCommand('aboutVersion', this.aboutVersionHandler);
    this.registerCommand('openDocs', (path?: string) => {
      return openExternal(`https://vscode-sqltools.mteixeira.dev/${path || ''}`);
    });

    if (logger.outputChannel) {
      Context.subscriptions.push(logger.outputChannel);
    }
    this.loadPlugins();
    activationTimer.end();
    telemetry.registerTime('activation', activationTimer);
    this.displayReleaseNotesMessage();
    return {
      client: this.client,
      addAfterCommandSuccessHook: this.addAfterCommandSuccessHook,
      registerPlugin: this.registerPlugin,
      addBeforeCommandHook: this.addBeforeCommandHook,
      registerCommand: this.registerCommand,
      registerTextEditorCommand: this.registerTextEditorCommand,
      errorHandler: this.errorHandler,
      resourcesMap: this.resourcesMap,
    };
  }

  public deactivate = (): void => {
    return Context.subscriptions.forEach((sub) => void sub.dispose());
  }

  public resourcesMap = (): typeof PluginResourcesMap => {
    return PluginResourcesMap;
  }

  private getIssueTemplate = (name: string) => {
    const url = `https://raw.githubusercontent.com/mtxr/vscode-sqltools/master/.github/ISSUE_TEMPLATE/${name}`;
    return new Promise<string>((resolve) => {
      https.get(url, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk.toString());
        resp.on('end', () => resolve(data));
      }).on('error', () => resolve(null));
    });
  }

  private aboutVersionHandler = async () => {
    const FoundABug = 'Found a bug?';
    const FeatureRequest = 'Feature Request';
    const message = [
      `${DISPLAY_NAME} v${VERSION}`,
      '',
      `Platform: ${process.platform}, ${process.arch}`,
      `Using Node Runtime: ${Config.useNodeRuntime ? 'yes' : 'no'}`,
      '',
      `by @mtxr ${AUTHOR}`
    ];
    const res = await window.showInformationMessage(message.join('\n'), { modal: true }, FeatureRequest, FoundABug);
    if (!res) return;
    const newIssueUrl = 'https://github.com/mtxr/vscode-sqltools/issues/new';

    try {
      let template: string;
      let body: string;

      switch (res) {
        case FoundABug:
          template = 'bug_report.md';
          break;
        case FeatureRequest:
          template = 'feature_request.md';
          break;
      }
      body = await this.getIssueTemplate(template);
      if (body) {
        body = encodeURIComponent(
          body
          .replace(/---([^\-]+---\n\n)/gim, '')
          .replace(/(- OS).+/gi, `$1: ${process.platform}, ${process.arch}`)
          .replace(/(- Version).+/gi, `$1: v${VERSION}`));
      }

      if (!template && !body) {
        return openExternal(`${newIssueUrl}/choose`);
      }
      let issueUrl = `${newIssueUrl}?assignees=&labels=feature+request&template=${template}&body=${body}`;
      openExternal(issueUrl);
    } catch (e) {
      const res = await window.showInformationMessage('Could not open a issue. Please go to GitHub to open.', 'Open Github');
      if (res) {
        openExternal(`${newIssueUrl}/choose`);
      }
    }

  }

  /**
   * Management functions
   */
  private displayReleaseNotesMessage = async () => {
    try {
      const current = Utils.getlastRunInfo();
      const { lastNotificationDate = 0, updated } = current;
      const lastNDate = parseInt(new Date(lastNotificationDate).toISOString().substr(0, 10).replace(/\D/g, ''), 10);
      const today = parseInt(new Date().toISOString().substr(0, 10).replace(/\D/g, ''), 10);
      const updatedRecently = (today - lastNDate) < 2;

      if (
        Config.disableReleaseNotifications
        || !updated
        || updatedRecently
      ) return;

      Utils.updateLastRunInfo({ lastNotificationDate: +new Date() });

      const moreInfo = 'More Info';
      const supportProject = 'Support This Project';
      const releaseNotes = 'Release Notes';
      const message = `${DISPLAY_NAME} updated! Check out the release notes for more information.`;
      const options = [ moreInfo, supportProject, releaseNotes ];
      const res: string = await window.showInformationMessage(message, ...options);
      telemetry.registerMessage('info', message, res);
      switch (res) {
        case moreInfo:
          openExternal('https://vscode-sqltools.mteixeira.dev/#donate-and-support');
          break;
        case releaseNotes:
          openExternal(current.releaseNotes);
          break;
        case supportProject:
          openExternal('https://www.patreon.com/mteixeira');
          break;
      }
    } catch (e) { /***/ }
  }

  private loadPlugins = () => {
    const pluginsQueue = this.pluginsQueue;
    this.pluginsQueue = [];
    this.loaded = this.loaded || true;
    for (let plugin of pluginsQueue) {
      try {
        plugin.register(this);
        if (plugin.extensionId) {
          this.extPlugins[plugin.type || 'general'] = this.extPlugins[plugin.type || 'general'] || [];
          if (!this.extPlugins[plugin.type || 'general'].includes(plugin.extensionId)) {
            this.extPlugins[plugin.type || 'general'].push(plugin.extensionId);
          }
        }
      } catch (error) {
        this.errorHandler(`Error loading plugin ${plugin.name}`, error);
      }
    }
    this.updateExtPluginsInfo();
  }

  private updateExtPluginsInfo = debounce(async () => {
    Utils.updateLastRunInfo({ installedExtPlugins: this.extPlugins });
    await Context.globalState.update('extPlugins', this.extPlugins);
  });

  private onWillRunCommandHandler = (evt: ICommandEvent): void => {
    if (!evt.command) return;
    if (!this.willRunCommandHooks[evt.command] || this.willRunCommandHooks[evt.command].length === 0) return;

    log.extend('debug')(`Will run ${this.willRunCommandHooks[evt.command].length} attached handler for 'beforeCommandHooks'`)
    this.willRunCommandHooks[evt.command].forEach(hook => hook(evt));
  }
  private onDidRunCommandSuccessfullyHandler = (evt: ICommandSuccessEvent): void => {
    if (!evt.command) return;
    if (!this.didRunCommandSuccessfullyHooks[evt.command] || this.didRunCommandSuccessfullyHooks[evt.command].length === 0) return;

    log.extend('debug')(`Will run ${this.didRunCommandSuccessfullyHooks[evt.command].length} attached handler for 'afterCommandSuccessfullyHooks'`)
    this.didRunCommandSuccessfullyHooks[evt.command].forEach(hook => hook(evt));
  }

  private addHook = (prop: 'willRunCommandHooks' | 'didRunCommandSuccessfullyHooks', command: string, handler: any) => {
    if (!this[prop][command]) {
      this[prop][command] = [];
    }
    this[prop][command].push(handler);
    return this;
  }

  public addBeforeCommandHook = (command: string, handler: CommandEventHandler<ICommandEvent>) => {
    return this.addHook('willRunCommandHooks', command, handler);
  }

  public addAfterCommandSuccessHook = (command: string, handler: CommandEventHandler<ICommandSuccessEvent>) => {
    return this.addHook('didRunCommandSuccessfullyHooks', command, handler);
  }

  public registerPlugin = (plugins: IExtensionPlugin | IExtensionPlugin[]) => {
    this.pluginsQueue.push(...(Array.isArray(plugins) ? plugins : [plugins]));
    if (this.loaded) {
      this.loadPlugins();
    }
    return this;
  }

  public registerCommand = (command: string, handler: Function) => {
    return this.decorateAndRegisterCommand(command, handler);
  }

  public registerTextEditorCommand = (command: string, handler: Function) => {
    return this.decorateAndRegisterCommand(command, handler, 'registerTextEditorCommand');
  }

  public errorHandler = (message: string, error: any) => {
    return ErrorHandler.create(message)(error);
  }

  private decorateAndRegisterCommand = (command: string, handler: Function, type: 'registerCommand' | 'registerTextEditorCommand' = 'registerCommand') => {
    Context.subscriptions.push(
      commands[type](`${EXT_NAMESPACE}.${command}`, async (...args) => {
        process.env.NODE_ENV === 'development' && log.extend('info')(`EXECUTING => ${EXT_NAMESPACE}.${command} %O`, args);
        process.env.NODE_ENV !== 'development' && log.extend('info')(`EXECUTING => ${EXT_NAMESPACE}.${command}`);

        this.onWillRunCommandEmitter.fire({ command, args });

        let result = handler(...args);
        if (typeof result !== 'undefined' && (typeof result.then === 'function' || typeof result.catch === 'function')) {
          result = await result;
          // @FEATURE: add on fail hook
        }
        this.onDidRunCommandSuccessfullyEmitter.fire({ args, command, result });
        return result;
      })
    );
    return this;
  }
}

let instance: SQLToolsExtension;
export function activate(ctx: ExtensionContext) {
  try {

    Context.set(ctx);
    if (instance) return;
    migrateFilesToNewPaths();
    instance = new SQLToolsExtension();
    instance.registerPlugin([
      FormatterPlugin,
      new ConnectionManagerPlugin(instance),
      new HistoryManagerPlugin,
      new BookmarksManagerPlugin,
    ])
    return instance.activate();

  } catch (err) {
    logger.extend('fatal')('failed to activate: %O', err);
  }
}

export function deactivate() {
  if (!instance) return;
  instance.deactivate();
  instance = undefined;
}
