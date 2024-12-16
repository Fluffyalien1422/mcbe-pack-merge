import { MergeSubDirPayload, Plugin, PluginApi } from "./plugins.js";
import * as path from "path";
import * as fs from "fs";
import { jsonc } from "jsonc";

const blockIds = new Map<string, string>();
const entityIds = new Map<string, string>();
const itemIds = new Map<string, string>();
const recipeIds = new Map<string, string>();
const texts = new Map<string, Map<string, string>>();

async function mergeSubDir(
  api: PluginApi,
  { addonName, subDirName, fullSubDirName, subDirPath }: MergeSubDirPayload
): Promise<boolean> {
  const config = api.getConfig();
  const outBpPath = api.getOutBpPath();

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
          api.warn(
            `Duplicate definition for '${id}' at '${fullFileName}' (originally found at '${ogPath}'). '${ogPath}' will take precendence.`
          );
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
        api.requireManualMerge(
          fullFileName,
          "Directories inside 'texts' are unsupported."
        );
        continue;
      }

      if (file.name === "languages.json") {
        continue;
      }

      if (!file.name.endsWith(".lang")) {
        api.requireManualMerge(fullFileName, "Unsupported file.");
        continue;
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
            api.warn(
              `Duplicate definition for '${key}' at '${fullFileName}'. The original value will take precedence.`
            );
          }
          continue;
        }

        translations.set(key, value);
      }
    }
  }

  switch (subDirName) {
    case "blocks":
      await mergeWithDuplicateIdCheck(blockIds);
      return true;
    case "entities":
      await mergeWithDuplicateIdCheck(entityIds);
      return true;
    case "items":
      await mergeWithDuplicateIdCheck(itemIds);
      return true;
    case "recipes":
      await mergeWithDuplicateIdCheck(recipeIds);
      return true;
    case "scripts":
      await fs.promises.cp(
        subDirPath,
        path.join(outBpPath, "scripts", addonName),
        { recursive: true }
      );
      return true;
    case "texts":
      await mergeTexts();
      return true;
  }

  return false;
}

function finishUp(api: PluginApi): void {
  if (!texts.size) return;

  const outRpPath = api.getOutRpPath();

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

export const corePlugin: Plugin = {
  hooks: {
    mergeSubDir,
    finishUp,
  },
};
