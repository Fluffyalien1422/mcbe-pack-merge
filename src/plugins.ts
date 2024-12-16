import { Config } from "./config.js";
import { MaybePromise } from "./utils.js";

export interface PluginApi {
  getConfig(): Config;
  getOutBpPath(): string;
  getOutRpPath(): string;
  warn(message: string): void;
  info(message: string): void;
  requireManualMerge(fileName: string, reason: string): void;
}

export type PluginHook<TArg = undefined, TReturn = MaybePromise<void>> = (
  api: PluginApi,
  arg: TArg
) => TReturn;

export interface MergeSubDirPayload {
  addonName: string;
  packName: string;
  subDirName: string;
  fullSubDirName: string;
  subDirPath: string;
}

export interface PluginHooks {
  mergeSubDir?: PluginHook<MergeSubDirPayload, MaybePromise<boolean>>;
  finishUp?: PluginHook;
}

export interface Plugin {
  hooks?: PluginHooks;
}
