import { MergeSubDirPayload, Plugin, PluginApi } from "./plugins.js";
import * as path from "path";
import * as fs from "fs";
import { jsonc } from "jsonc";

const blockIds = new Map<string, string>();
const entityIds = new Map<string, string>();
const itemIds = new Map<string, string>();
const recipeIds = new Map<string, string>();
const texts = new Map<string, Map<string, string>>();
const geometries = new Map<string, object>();
const flipbookTextureData = new Map<string, object>();
const itemTextureData = new Map<string, object>();
const terrainTextureData = new Map<string, object>();

async function mergeSubDir(
  api: PluginApi,
  { addonName, subDirName, fullSubDirName, subDirPath }: MergeSubDirPayload
): Promise<boolean> {
  const config = api.getConfig();
  const outBpPath = api.getOutBpPath();
  const outRpPath = api.getOutRpPath();

  function setOrDuplicateIdWarning<T>(
    fullFileName: string,
    map: Map<string, T>,
    key: string,
    value: T,
    originalFileName?: string
  ): boolean {
    if (map.has(key)) {
      if (config.duplicateIdentifierWarnings) {
        api.warn(
          originalFileName
            ? `Duplicate definition for '${key}' at '${fullFileName}'. The original value at '${originalFileName}' will take precedence.`
            : `Duplicate definition for '${key}' at '${fullFileName}'. The original value will take precedence.`
        );
      }
      return false;
    }

    map.set(key, value);
    return true;
  }

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
        path.join(file.parentPath, file.name)
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

      if (
        setOrDuplicateIdWarning(
          fullFileName,
          ids,
          id,
          fullFileName,
          ids.get(id)
        )
      ) {
        await fs.promises.cp(
          path.join(file.parentPath, file.name),
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

      const fullFilePath = path.join(file.parentPath, file.name);

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

        setOrDuplicateIdWarning(fullFileName, translations, key, value);
      }
    }
  }

  async function mergeModels(): Promise<void> {
    for (const file of await fs.promises.readdir(subDirPath, {
      withFileTypes: true,
      recursive: true,
    })) {
      if (file.isDirectory()) continue;

      const fullFileName = path.join(fullSubDirName, file.name);
      const fullFilePath = path.join(file.parentPath, file.name);

      const content = (await jsonc.read(fullFilePath)) as {
        format_version: string;
        "minecraft:geometry": Array<{ description: { identifier: string } }>;
      };

      if (content.format_version !== "1.12.0") {
        api.requireManualMerge(
          fullFileName,
          `Format version '${content.format_version}' is unsupported, expected '1.12.0'.`
        );
        continue;
      }

      for (const geometry of content["minecraft:geometry"]) {
        setOrDuplicateIdWarning(
          fullFileName,
          geometries,
          geometry.description.identifier,
          geometry
        );
      }
    }
  }

  async function mergeTextures(): Promise<void> {
    const flipbookTexturesPath = path.join(
      subDirPath,
      "flipbook_textures.json"
    );
    const flipbookTexturesFullName = path.join(
      fullSubDirName,
      "flipbook_textures.json"
    );

    const itemTexturePath = path.join(subDirPath, "item_texture.json");
    const itemTextureFullName = path.join(fullSubDirName, "item_texture.json");

    const terrainTexturePath = path.join(subDirPath, "terrain_texture.json");
    const terrainTextureFullName = path.join(
      fullSubDirName,
      "terrain_texture.json"
    );

    if (fs.existsSync(flipbookTexturesPath)) {
      const flipbookTextures = (await jsonc.read(
        flipbookTexturesPath
      )) as Array<{
        atlas_tile: string;
      }>;

      for (const flipbookTexture of flipbookTextures) {
        setOrDuplicateIdWarning(
          flipbookTexturesFullName,
          flipbookTextureData,
          flipbookTexture.atlas_tile,
          flipbookTexture
        );
      }
    }

    if (fs.existsSync(itemTexturePath)) {
      const itemTexture = (await jsonc.read(itemTexturePath)) as {
        texture_data: Record<string, object>;
      };

      for (const [key, value] of Object.entries(itemTexture.texture_data)) {
        setOrDuplicateIdWarning(
          itemTextureFullName,
          itemTextureData,
          key,
          value
        );
      }
    }

    if (fs.existsSync(terrainTexturePath)) {
      const terrainTexture = (await jsonc.read(terrainTexturePath)) as {
        texture_data: Record<string, object>;
      };

      for (const [key, value] of Object.entries(terrainTexture.texture_data)) {
        setOrDuplicateIdWarning(
          terrainTextureFullName,
          terrainTextureData,
          key,
          value
        );
      }
    }

    return fs.promises.cp(subDirPath, path.join(outRpPath, "textures"), {
      recursive: true,
    });
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
    case "models":
      await mergeModels();
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
    case "textures":
      await mergeTextures();
      return true;
  }

  return false;
}

function finishUp(api: PluginApi): void {
  const outRpPath = api.getOutRpPath();

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

  if (geometries.size) {
    const modelsDir = path.join(outRpPath, "models");
    fs.mkdirSync(modelsDir);

    fs.writeFileSync(
      path.join(modelsDir, "geometries.json"),
      JSON.stringify({
        format_version: "1.12.0",
        "minecraft:geometry": [...geometries.values()],
      })
    );
  }

  const texturesDir = path.join(outRpPath, "textures");

  if (flipbookTextureData.size) {
    fs.writeFileSync(
      path.join(texturesDir, "flipbook_textures.json"),
      JSON.stringify([...flipbookTextureData.values()])
    );
  }

  if (itemTextureData.size) {
    fs.writeFileSync(
      path.join(texturesDir, "item_texture.json"),
      JSON.stringify({
        texture_data: Object.fromEntries(itemTextureData.entries()),
      })
    );
  }

  if (terrainTextureData.size) {
    fs.writeFileSync(
      path.join(texturesDir, "terrain_texture.json"),
      JSON.stringify({
        texture_data: Object.fromEntries(terrainTextureData.entries()),
      })
    );
  }
}

export const corePlugin: Plugin = {
  hooks: {
    mergeSubDir,
    finishUp,
  },
};
