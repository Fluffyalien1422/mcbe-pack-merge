import * as fs from "fs";
import * as path from "path";
import decompress from "decompress";
import { pino as pinoInit } from "pino";
import pinoPrettyInit from "pino-pretty";
import { jsonc } from "jsonc";
import * as semver from "semver";
import { Config } from "./config.js";
import * as uuid from "uuid";

const pino = pinoInit(pinoPrettyInit());

export async function mergePacks(config: Config): Promise<void> {
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
  const blockIds = new Map<string, string>();
  const entityIds = new Map<string, string>();
  const itemIds = new Map<string, string>();
  const recipeIds = new Map<string, string>();
  const texts = new Map<string, Map<string, string>>();
  const scriptModuleVersions: Record<string, string> = {};
  const manualMergesRequired: string[] = [];
  const scriptEntryPoints: string[] = [];

  async function mergePackSubDir(
    addonName: string,
    packName: string,
    subDirName: string,
    subDirPath: string
  ): Promise<void> {
    const fullSubDirName = path.join(addonName, packName, subDirName);

    async function mergeWithDuplicateIdCheck(
      ids: Map<string, string>
    ): Promise<void> {
      const destDir = path.join(outBpPath, subDirName, addonName);

      for (const file of await fs.promises.readdir(subDirPath, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (file.isDirectory()) continue;

        const content = (await jsonc.read(
          path.join(subDirPath, file.name)
        )) as Record<string, { description: { identifier: string } }>;

        const fullFileName = path.join(fullSubDirName, file.name);

        const rootKey = Object.keys(content).find((key) =>
          key.startsWith("minecraft:")
        );
        if (!rootKey) {
          throw new Error(
            `Cannot get root object key for file '${fullFileName}'.`
          );
        }

        const id = content[rootKey].description.identifier;

        if (ids.has(id)) {
          if (config.duplicateIdentifierWarnings) {
            const ogPath = ids.get(id)!;
            pino.warn(
              `Duplicate definition for '${id}' at '${fullFileName}' (originally found at '${ogPath}'). '${ogPath}' will take precendence.`
            );
            warningsCount++;
          }
        } else {
          ids.set(id, fullFileName);
          await fs.promises.cp(
            path.join(subDirPath, file.name),
            path.join(destDir, file.name)
          );
        }
      }
    }

    async function mergeTexts(): Promise<void> {
      for (const file of await fs.promises.readdir(subDirPath, {
        withFileTypes: true,
      })) {
        const fullFileName = path.join(fullSubDirName, file.name);

        if (file.isDirectory()) {
          const manualMergeMsg = `'${fullFileName}' - Directories inside 'texts' are unsupported.`;
          manualMergesRequired.push(manualMergeMsg);
          pino.warn(`Manual merge required for ${manualMergeMsg}`);
          warningsCount++;
        }

        if (file.name === "languages.json") {
          continue;
        }

        if (!file.name.endsWith(".lang")) {
          const manualMergeMsg = `'${fullFileName}' - Unsupported file.`;
          manualMergesRequired.push(manualMergeMsg);
          pino.warn(`Manual merge required for ${manualMergeMsg}`);
          warningsCount++;
        }

        const fullFilePath = path.join(subDirPath, file.name);

        const content = await fs.promises.readFile(fullFilePath, "utf8");
        const lines = content.split("\n");

        const language = path.basename(file.name, ".lang");

        let translations = texts.get(language);
        if (!translations) {
          translations = new Map();
          texts.set(language, translations);
        }

        for (const lineRaw of lines) {
          const line = lineRaw.trim();
          if (!line || line.startsWith("##")) continue;

          const [key, value] = line.split(/=(.*)/);
          if (key === "pack.name" || key === "pack.description") continue;

          if (translations.has(key)) {
            if (config.duplicateIdentifierWarnings) {
              pino.warn(
                `Duplicate definition for '${key}' at '${fullFileName}'. The original value will take precedence.`
              );
              warningsCount++;
            }
            continue;
          }

          translations.set(key, value);
        }
      }
    }

    switch (subDirName) {
      case "blocks":
        return mergeWithDuplicateIdCheck(blockIds);
      case "entities":
        return mergeWithDuplicateIdCheck(entityIds);
      case "items":
        return mergeWithDuplicateIdCheck(itemIds);
      case "recipes":
        return mergeWithDuplicateIdCheck(recipeIds);
      case "scripts":
        return fs.promises.cp(
          subDirPath,
          path.join(outBpPath, "scripts", addonName),
          { recursive: true }
        );
      case "texts":
        return mergeTexts();
      default: {
        const manualMergeMsg = `'${fullSubDirName}' - Unsupported subdirectory.`;
        manualMergesRequired.push(manualMergeMsg);
        pino.warn(`Manual merge required for ${manualMergeMsg}`);
        warningsCount++;
      }
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
        pino.warn(
          `Script module '${dependency.module_name}' versions '${dependency.version}' and '${existingVer}' are incompatible. This may cause script errors.`
        );
        warningsCount++;
      }
    }

    for (const packSubDir of fs.readdirSync(packDir, { withFileTypes: true })) {
      if (!packSubDir.isDirectory()) continue;

      const packSubDirFullPath = path.join(packDir, packSubDir.name);
      promises.push(
        mergePackSubDir(
          addonName,
          packName,
          packSubDir.name,
          packSubDirFullPath
        )
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

  pino.info("Finishing up");

  fs.rmSync(tmpDir, { recursive: true });

  if (scriptEntryPoints.length) {
    fs.writeFileSync(
      path.join(outBpPath, "scripts/index.js"),
      scriptEntryPoints.map((entryPoint) => `import"./${entryPoint}";`).join("")
    );
  }

  if (texts.size) {
    const textsDir = path.join(outRpPath, "texts");
    fs.mkdirSync(textsDir);

    for (const [lang, translations] of texts) {
      fs.writeFileSync(
        path.join(textsDir, `${lang}.lang`),
        [...translations.entries()]
          .map(([key, val]) => `${key}=${val}\n`)
          .join("")
      );
    }

    fs.writeFileSync(
      path.join(textsDir, "languages.json"),
      JSON.stringify([...texts.keys()])
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
