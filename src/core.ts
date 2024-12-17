import * as fs from "fs";
import * as path from "path";
import decompress from "decompress";
import { pino as pinoInit } from "pino";
import pinoPrettyInit from "pino-pretty";
import { jsonc } from "jsonc";
import * as semver from "semver";
import { Config } from "./config.js";
import * as uuid from "uuid";
import { MergeSubDirPayload, Plugin, PluginApi } from "./plugins.js";
import { corePlugin } from "./core_plugin.js";

const pino = pinoInit(pinoPrettyInit());

export async function mergePacks(
  config: Config,
  plugins: Plugin[] = []
): Promise<void> {
  plugins.push(corePlugin);
  config.duplicateIdentifierWarnings ??= true;

  const packPaths =
    "dir" in config.input
      ? fs
          .readdirSync(config.input.dir)
          .map((fileName) =>
            path.join((config.input as { dir: string }).dir, fileName)
          )
      : config.input.packs;

  if (fs.existsSync(config.outDir)) {
    throw new Error(`The out directory '${config.outDir}' already exists.`);
  }

  fs.mkdirSync(config.outDir);

  const tmpDir = fs.mkdtempSync("tmp");

  const decompressPromises: Promise<void>[] = [];

  const packBaseNames: string[] = [];

  for (const packPath of packPaths) {
    const packBaseName = path.basename(packPath);
    packBaseNames.push(packBaseName);

    pino.info(`Decompressing pack '${packPath}'.`);

    decompressPromises.push(
      decompress(packPath, path.join(tmpDir, packBaseName)).then(() => {
        pino.info(`Decompressed pack '${packPath}'.`);
      })
    );
  }

  await Promise.all(decompressPromises);

  pino.info("All packs decompressed.");

  const outBpPath = path.join(config.outDir, "BP");
  const outRpPath = path.join(config.outDir, "RP");

  fs.mkdirSync(outBpPath);
  fs.mkdirSync(outRpPath);

  let warningsCount = 0;
  let minEngineVersionStr = "1.21.50";

  const scriptModuleVersions: Record<string, string> = {};
  const manualMergesRequired: string[] = [];
  const scriptEntryPoints: string[] = [];

  const pluginApi: PluginApi = {
    getConfig() {
      return { ...config, input: { ...config.input } };
    },

    getOutBpPath() {
      return outBpPath;
    },

    getOutRpPath() {
      return outRpPath;
    },

    warn(message: string) {
      pino.warn(message);
      warningsCount++;
    },

    info(message: string) {
      pino.info(message);
    },

    requireManualMerge(fileName: string, reason: string) {
      const manualMergeMsg = `'${fileName}' - ${reason}`;
      manualMergesRequired.push(manualMergeMsg);
      this.warn(`Manual merge required for ${manualMergeMsg}`);
    },
  };

  async function mergePackSubDir(options: MergeSubDirPayload): Promise<void> {
    let merged = false;

    for (const plugin of plugins) {
      const result = await plugin.hooks?.mergeSubDir?.(pluginApi, {
        ...options,
      });
      if (result) merged = true;
    }

    if (!merged) {
      pluginApi.requireManualMerge(
        options.fullSubDirName,
        "Subdirectory could not be merged."
      );
    }
  }

  async function mergePack(
    addonName: string,
    packName: string,
    packDir: string
  ): Promise<void> {
    const promises: Promise<void>[] = [];

    const manifestPath = path.join(packDir, "manifest.json");
    const manifest = (await jsonc.read(manifestPath)) as {
      header: {
        min_engine_version: [number, number, number];
      };
      modules: Array<{ type: string; entry?: string }>;
      dependencies?: Array<{
        module_name?: string;
        version: string;
      }>;
    };

    const packMinEngineVerStr = manifest.header.min_engine_version.join(".");
    if (semver.gt(packMinEngineVerStr, minEngineVersionStr)) {
      minEngineVersionStr = packMinEngineVerStr;
    }

    const scriptEntry = manifest.modules.find(
      (module) => module.type === "script"
    )?.entry;

    if (scriptEntry) {
      scriptEntryPoints.push(addonName + scriptEntry.slice("scripts".length));
    }

    for (const dependency of manifest.dependencies ?? []) {
      if (!dependency.module_name) continue;

      const existingVer = scriptModuleVersions[dependency.module_name];

      if (!existingVer || semver.gt(dependency.version, existingVer)) {
        scriptModuleVersions[dependency.module_name] = dependency.version;
      }

      if (
        existingVer &&
        !semver.satisfies(dependency.version, `^${existingVer}`)
      ) {
        pluginApi.warn(
          `Script module '${dependency.module_name}' versions '${dependency.version}' and '${existingVer}' are incompatible. This may cause script errors.`
        );
      }
    }

    for (const packSubDir of fs.readdirSync(packDir, { withFileTypes: true })) {
      if (!packSubDir.isDirectory()) continue;

      const packSubDirFullPath = path.join(
        packSubDir.parentPath,
        packSubDir.name
      );
      const packSubDirFullName = path.join(
        addonName,
        packName,
        packSubDir.name
      );

      promises.push(
        mergePackSubDir({
          addonName,
          packName,
          subDirName: packSubDir.name,
          fullSubDirName: packSubDirFullName,
          subDirPath: packSubDirFullPath,
        })
      );
    }

    await Promise.all(promises);
  }

  for (const addonDir of packBaseNames) {
    const addonDirFullPath = path.join(tmpDir, addonDir);
    pino.info(`Merging pack '${addonDir}'.`);

    for (const packDir of fs.readdirSync(addonDirFullPath)) {
      const packDirFullPath = path.join(addonDirFullPath, packDir);
      await mergePack(addonDir, packDir, packDirFullPath);
    }

    pino.info(`Merged pack '${addonDir}'.`);
  }

  pino.info("Finishing up.");

  fs.rmSync(tmpDir, { recursive: true });

  for (const plugin of plugins) {
    await plugin.hooks?.finishUp?.(pluginApi, undefined);
  }

  if (scriptEntryPoints.length) {
    fs.writeFileSync(
      path.join(outBpPath, "scripts/index.js"),
      scriptEntryPoints.map((entryPoint) => `import"./${entryPoint}";`).join("")
    );
  }

  const outPackName = "Merged Pack";
  const outPackDescription = `Contains '${packBaseNames.join("', '")}'`;
  const outPackVersion = "1.0.0";
  const outBpManifestHeaderUuid = uuid.v4();
  const outBpManifestDataUuid = uuid.v4();
  const outBpManifestScriptUuid = uuid.v4();
  const outRpManifestHeaderUuid = uuid.v4();
  const outRpManifestResourcesUuid = uuid.v4();

  const minEngineVersion = minEngineVersionStr
    .split(".")
    .map((num) => Number(num));

  fs.writeFileSync(
    path.join(outBpPath, "manifest.json"),
    JSON.stringify({
      format_version: 2,
      header: {
        name: outPackName,
        description: outPackDescription,
        min_engine_version: minEngineVersion,
        uuid: outBpManifestHeaderUuid,
        version: outPackVersion,
      },
      modules: [
        {
          type: "data",
          uuid: outBpManifestDataUuid,
          version: "1.0.0",
        },
        ...(scriptEntryPoints.length
          ? [
              {
                type: "script",
                language: "javascript",
                uuid: outBpManifestScriptUuid,
                entry: "scripts/index.js",
                version: "1.0.0",
              },
            ]
          : []),
      ],
      dependencies: [
        {
          uuid: outRpManifestHeaderUuid,
          version: outPackVersion,
        },
        ...Object.entries(scriptModuleVersions).map(([module, version]) => ({
          module_name: module,
          version,
        })),
      ],
    })
  );

  fs.writeFileSync(
    path.join(outRpPath, "manifest.json"),
    JSON.stringify({
      format_version: 2,
      header: {
        name: outPackName,
        description: outPackDescription,
        min_engine_version: minEngineVersion,
        uuid: outRpManifestHeaderUuid,
        version: outPackVersion,
      },
      modules: [
        {
          type: "resources",
          uuid: outRpManifestResourcesUuid,
          version: "1.0.0",
        },
      ],
      dependencies: [
        {
          uuid: outBpManifestHeaderUuid,
          version: outPackVersion,
        },
      ],
    })
  );

  if (warningsCount <= 0) {
    pino.info("Completed with 0 warnings.");
  } else {
    pino.warn(`Completed with ${warningsCount.toString()} warnings.`);
  }
}
